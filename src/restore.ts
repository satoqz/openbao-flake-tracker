import { Octokit } from "octokit";
import JSZip from "jszip";

const REPO = { owner: "satoqz", repo: "openbao-flake-database" };

const octokit = new Octokit({
  userAgent: "openbao-flake-database/v0.1.0",
  auth: Deno.env.get("GITHUB_TOKEN"),
});

async function main(): Promise<void> {
  // Get the previous workflow run.
  const { data: { workflow_runs: runs } } = await octokit.rest.actions
    .listWorkflowRuns({
      ...REPO,
      workflow_id: "database.yml",
      status: "success",
      per_page: 1,
    });

  if (runs.length == 0) {
    return console.log("No previous run found!");
  }

  const run = runs[0];

  const { data: { artifacts } } = await octokit.rest.actions
    .listWorkflowRunArtifacts({
      ...REPO,
      run_id: run.id,
    });

  if (artifacts.length == 0) {
    return console.log("No artifacts found!");
  }

  const artifact = artifacts[0];

  const { data } = await octokit.rest.actions.downloadArtifact({
    ...REPO,
    artifact_id: artifact.id,
    archive_format: "zip",
  });

  const zip = await JSZip.loadAsync(data as ArrayBuffer);

  for (const file of Object.values(zip.files)) {
    const content = await file.async("uint8array");
    const database = await Deno.open("tests.db", { create: true, write: true });
    await database.write(content);
    break;
  }

  console.log("Restored database!");
}

await main();
