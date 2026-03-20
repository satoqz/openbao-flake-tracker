import { Octokit } from "octokit";
import JSZip from "jszip";

const REPO = {
  owner: Deno.env.get("OWNER") || "satoqz",
  repo: Deno.env.get("REPO") || "openbao-flake-tracker",
};

const octokit = new Octokit({
  userAgent: "openbao-flake-tracker/v0.1.0",
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

  // Get the first artifact.
  const { data: { artifacts } } = await octokit.rest.actions
    .listWorkflowRunArtifacts({
      ...REPO,
      run_id: run.id,
    });
  if (artifacts.length == 0) {
    return console.log("No artifacts found!");
  }
  const artifact = artifacts[0];

  // Download and read the artifact.
  const { data } = await octokit.rest.actions.downloadArtifact({
    ...REPO,
    artifact_id: artifact.id,
    archive_format: "zip",
  });
  const zip = await JSZip.loadAsync(data as ArrayBuffer);
  const file = Object.values(zip.files).at(0);
  if (!file) {
    return console.log("No files found in artifact?");
  }

  // Then write out the SQLite file.
  const contents = await file.async("uint8array");
  const database = await Deno.open("tests.db", { create: true, write: true });
  await database.write(contents);

  console.log("Restored database!");
}

await main();
