import os
from io import BytesIO
from pathlib import Path
from zipfile import ZipFile

from githubkit import GitHub

REPO = {
    "owner": os.environ.get("OWNER") or "satoqz",
    "repo": os.environ.get("REPO") or "openbao-flake-tracker",
}


def restore(github: GitHub) -> None:
    # Get the previous workflow run.
    runs = github.rest.actions.list_workflow_runs(
        owner=REPO["owner"],
        repo=REPO["repo"],
        workflow_id="database.yml",
        status="success",
        per_page=1,
    ).parsed_data.workflow_runs
    if not runs:
        print("No previous run found!")
        return
    run = runs[0]

    # Get the first artifact.
    artifacts = github.rest.actions.list_workflow_run_artifacts(
        owner=REPO["owner"],
        repo=REPO["repo"],
        run_id=run.id,
    ).parsed_data.artifacts
    if not artifacts:
        print("No artifacts found!")
        return
    artifact = artifacts[0]

    # Download and read the artifact.
    data = github.rest.actions.download_artifact(
        owner=REPO["owner"],
        repo=REPO["repo"],
        artifact_id=artifact.id,
        archive_format="zip",
    ).content
    with ZipFile(BytesIO(data)) as archive:
        files = archive.namelist()
        if not files:
            print("No files found in artifact?")
            return

        # Then write out the SQLite file.
        Path("tests.db").write_bytes(archive.read(files[0]))

    print("Restored database!")


if __name__ == "__main__":
    with GitHub(
        os.environ.get("GITHUB_TOKEN"),
        user_agent="openbao-flake-tracker/v0.1.0",
    ) as github:
        restore(github)
