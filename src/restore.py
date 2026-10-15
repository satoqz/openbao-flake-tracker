import os
from io import BytesIO
from pathlib import Path
from zipfile import ZipFile

from githubkit import GitHub

REPO = {
    "owner": os.environ.get("OWNER") or "satoqz",
    "repo": os.environ.get("REPO") or "openbao-flake-tracker",
}


def restore(github: GitHub, *, run_id: int | None = None) -> None:
    # Unless explicitly selected, use the latest successful workflow run.
    if run_id is None:
        runs = github.rest.actions.list_workflow_runs(
            owner=REPO["owner"],
            repo=REPO["repo"],
            workflow_id="database.yml",
            status="success",
            per_page=1,
        ).parsed_data.workflow_runs
        if not runs:
            raise RuntimeError("No previous run found!")
        run_id = runs[0].id

    # Get the first artifact.
    artifacts = github.rest.actions.list_workflow_run_artifacts(
        owner=REPO["owner"],
        repo=REPO["repo"],
        run_id=run_id,
    ).parsed_data.artifacts
    if not artifacts:
        raise RuntimeError(f"No artifacts found for run {run_id}!")
    artifact = artifacts[0]

    # Download and read the artifact.
    data = github.rest.actions.download_artifact(
        owner=REPO["owner"],
        repo=REPO["repo"],
        artifact_id=artifact.id,
        archive_format="zip",
    ).content
    with ZipFile(BytesIO(data)) as archive:
        if "tests.db" not in archive.namelist():
            raise RuntimeError(f"No tests.db found in artifact for run {run_id}!")

        # Then write out the SQLite file.
        Path("tests.db").write_bytes(archive.read("tests.db"))

    print(f"Restored database from run {run_id}!")


if __name__ == "__main__":
    run_id = os.environ.get("RESTORE_FROM")
    with GitHub(
        os.environ.get("GITHUB_TOKEN"),
        user_agent="openbao-flake-tracker/v0.1.0",
    ) as github:
        restore(github, run_id=int(run_id) if run_id else None)
