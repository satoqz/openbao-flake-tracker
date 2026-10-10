import json
import os
import re
import sqlite3
from contextlib import closing
from datetime import UTC, datetime, timedelta
from io import BytesIO
from zipfile import ZipFile

from githubkit import GitHub

REPO = {
    "owner": os.environ.get("OWNER", "openbao"),
    "repo": os.environ.get("REPO", "openbao"),
}


def main(github: GitHub, db: sqlite3.Connection) -> None:
    db.execute("""
        CREATE TABLE IF NOT EXISTS failures (
          run_id INTEGER NOT NULL,
          job_id INTEGER NOT NULL,
          attempt INTEGER NOT NULL,
          package TEXT NOT NULL,
          function TEXT NOT NULL,
          timestamp TIMESTAMP NOT NULL,
          commit_sha TEXT,
          pull_request INTEGER,
          PRIMARY KEY (job_id, package, function)
        );
    """)

    insert = """
        INSERT INTO failures (
          run_id, job_id, attempt, package, function, timestamp, commit_sha, pull_request
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(job_id, package, function) DO NOTHING;
    """

    # Check workflows two days into the past by default.
    cutoff = datetime.now(UTC) - timedelta(days=int(os.environ.get("DAYS") or "2"))
    runs = github.rest.paginate(
        github.rest.actions.list_workflow_runs,
        owner=REPO["owner"],
        repo=REPO["repo"],
        workflow_id="ci.yml",
        status="success",
        per_page=100,
        created=f">{cutoff.date().isoformat()}",
        map_func=lambda response: response.parsed_data.workflow_runs,
    )

    for run in runs:
        # Skip run if it didn't have a previous attempt.
        if not run.run_attempt or run.run_attempt < 2:
            continue

        # Fetch the previous attempt.
        prev_run = github.rest.actions.get_workflow_run_attempt(
            owner=REPO["owner"],
            repo=REPO["repo"],
            run_id=run.id,
            attempt_number=run.run_attempt - 1,
        ).parsed_data

        # Skip run if the previous attempt didn't fail.
        if prev_run.conclusion != "failure":
            continue

        # Extract the pull request ID if this job was triggered by one.
        pull = None
        if run.event == "pull_request":
            pulls = github.rest.pulls.list(
                owner=REPO["owner"],
                repo=REPO["repo"],
                head=f"{run.head_repository.owner.login}:{run.head_branch}",
                state="all",
                per_page=1,
            ).parsed_data
            if pulls:
                pull = pulls[0].number

        # Fetch all jobs for the failed attempt.
        jobs = github.rest.actions.list_jobs_for_workflow_run_attempt(
            owner=REPO["owner"],
            repo=REPO["repo"],
            run_id=run.id,
            per_page=100,
            attempt_number=run.run_attempt - 1,
        ).parsed_data.jobs

        # Fetch all artifacts for the failed attempt.
        artifacts = github.rest.actions.list_workflow_run_artifacts(
            owner=REPO["owner"],
            repo=REPO["repo"],
            run_id=run.id,
            per_page=100,
        ).parsed_data.artifacts

        # We assume monotonic IDs and use this to map artifacts to previous
        # runs. The API is not great here, we cannot *fetch artifacts for a
        # given attempt*, we can only fetch *all* artifacts and then handle some
        # of them being duplicated. Eugh.
        artifacts.sort(key=lambda artifact: artifact.id)

        for job in jobs:
            # Filter for failed jobs.
            if job.conclusion != "failure":
                continue

            # Filter for test-go jobs.
            match = re.search(r"test-go \((\d+)\)$", job.name)
            if not match:
                continue

            # Map the failed job to the artifact we expect for it.
            mode = "race" if "with data race detection" in job.name else "default"
            artifact_name = f"test-results-{int(match[1])}-{mode}"
            matching = [a for a in artifacts if a.name == artifact_name]
            if len(matching) < 2:
                continue
            artifact = matching[-2]

            print(f"Downloading artifact for job {job.id}")

            # Then download, extract and parse the artifact.
            data = github.rest.actions.download_artifact(
                owner=REPO["owner"],
                repo=REPO["repo"],
                artifact_id=artifact.id,
                archive_format="zip",
            ).content

            with ZipFile(BytesIO(data)) as archive:
                for filename in archive.namelist():
                    # There's also an xml file that we don't care about.
                    if not filename.endswith(".json"):
                        continue

                    content = archive.read(filename).decode("utf-8")
                    for line in content.split("\n"):
                        # Ignore final trailing line.
                        if not line:
                            continue

                        test = json.loads(line)

                        # Filter for failed tests and remove package summaries
                        # or subtests.
                        if (
                            test["Action"] != "fail"
                            or not test.get("Test")
                            or "/" in test["Test"]
                        ):
                            continue

                        print(f"Inserting failure at {test['Package']}.{test['Test']}")

                        # Keep the existing database's UTC timestamp format.
                        timestamp = (
                            job.started_at.astimezone(UTC)
                            .replace(tzinfo=None)
                            .isoformat(timespec="milliseconds")
                            .replace("T", "")
                        )

                        db.execute(
                            insert,
                            (
                                run.id,
                                job.id,
                                run.run_attempt - 1,
                                test["Package"],
                                test["Test"],
                                timestamp,
                                run.head_commit.id if run.head_commit else None,
                                pull,
                            ),
                        )


if __name__ == "__main__":
    with (
        GitHub(
            os.environ.get("GITHUB_TOKEN"),
            user_agent="openbao-flake-tracker/v0.1.0",
        ) as github,
        closing(sqlite3.connect("tests.db", autocommit=True)) as db,
    ):
        main(github, db)
