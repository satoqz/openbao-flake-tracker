import { DatabaseSync } from "node:sqlite";
import { Octokit } from "octokit";
import JSZip from "jszip";

const db = new DatabaseSync("tests.db");

db.exec(
  `
    CREATE TABLE IF NOT EXISTS failures (
      run_id INTEGER NOT NULL,
      job_id INTEGER NOT NULL, 
      attempt INTEGER NOT NULL,
      package TEXT NOT NULL,
      function TEXT NOT NULL,
      timestamp TIMESTAMP NOT NULL,
      PRIMARY KEY (job_id, package, function)
    );
  `,
);

const insert = db.prepare(
  `
    INSERT INTO failures (
      run_id, job_id, attempt, package, function, timestamp 
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(job_id, package, function) DO NOTHING;
  `,
);

const REPO = { owner: "openbao", repo: "openbao" };

const octokit = new Octokit({
  userAgent: "openbao-flake-database/v0.1.0",
  auth: Deno.env.get("GITHUB_TOKEN"),
});

const runs = await octokit.paginate(octokit.rest.actions.listWorkflowRuns, {
  ...REPO,
  workflow_id: "ci.yml",
  status: "success",
  per_page: 100,
  created: `>${
    new Date(
      // Check workflows two days into the past by default.
      Date.now() - parseInt(Deno.env.get("DAYS") || "2") * 24 * 60 * 60 * 1000,
    ).toISOString().slice(0, 10)
  }`,
});

for (const run of runs) {
  // Skip run if it didn't have a previous attempt.
  if (!run.run_attempt || run.run_attempt < 2) continue;

  // Fetch the previous attempt.
  const { data: prevRun } = await octokit.rest.actions
    .getWorkflowRunAttempt({
      ...REPO,
      run_id: run.id,
      attempt_number: run.run_attempt - 1,
    });

  // Skip run if the previous attempt didn't fail.
  if (prevRun.conclusion != "failure") continue;

  console.log(`Flaky run: ${run.id}`);

  // Fetch all jobs for the failed attempts.
  const { data: { jobs } } = await octokit.rest.actions
    .listJobsForWorkflowRunAttempt({
      ...REPO,
      run_id: run.id,
      per_page: 100,
      attempt_number: run.run_attempt - 1,
    });

  // Fetch all artifacts for the failed attempt.
  const { data: { artifacts } } = await octokit.rest.actions
    .listWorkflowRunArtifacts({
      ...REPO,
      run_id: run.id,
      per_page: 100,
    });

  // We assume monotonic IDs and use this to map artifacts to previous runs.
  // The API is not great here, we cannot *fetch artifacts for a given attempt*,
  // we can only fetch *all* artifacts and then handle some of them being
  // duplicated. Eugh.
  artifacts.sort((a, b) => a.id - b.id);

  for (const job of jobs) {
    // Filter for failed jobs.
    if (job.conclusion != "failure") continue;

    // Filter for test-go jobs.
    const match = job.name.match(/test-go \((\d+)\)$/);
    if (!match) continue;

    // Map the failed job to the artifact we expect for it.
    const artifactName = `test-results-${parseInt(match[1], 10)}-${
      job.name.includes("with data race detection") ? "race" : "default"
    }`;
    const artifact = artifacts.filter((artifact) =>
      artifact.name == artifactName
    ).at(-2);

    if (!artifact) continue;

    console.log(`Downloading artifact for job ${job.id}`);

    // Then download, extract and parse the artifact.
    const { data } = await octokit.rest.actions
      .downloadArtifact({
        ...REPO,
        artifact_id: artifact.id,
        archive_format: "zip",
      });

    const zip = await JSZip.loadAsync(data as ArrayBuffer);
    for (const [filename, file] of Object.entries(zip.files)) {
      // There's also an xml file that we don't care about.
      if (!filename.endsWith(".json")) continue;

      const content = await file.async("uint8array");
      for (const line of new TextDecoder().decode(content).split("\n")) {
        // Ignore final trailing line.
        if (!line) continue;

        // {
        //   Time: "2026-03-04T10:02:14.994357286Z",
        //   Action: "fail",
        //   Package: "github.com/openbao/openbao/builtin/logical/pkiext/pkiext_binary",
        //   Test: "Test_ACME",
        //   Elapsed: 42.82
        // }
        const test = JSON.parse(line) as {
          Action: string;
          Package: string;
          Test?: string;
        };

        // Filter for failed tests and remove any package summaries or subtests.
        if (test.Action != "fail" || !test.Test || test.Test.includes("/")) {
          continue;
        }

        console.log(`Inserting failure at ${test.Package}.${test.Test}`);

        const timestamp = new Date(job.started_at).toISOString()
          .replace("T", "")
          .replace("Z", "");

        insert.run(
          run.id,
          job.id,
          run.run_attempt - 1,
          test.Package,
          test.Test,
          timestamp,
        );
      }
    }
  }
}

db.close();
