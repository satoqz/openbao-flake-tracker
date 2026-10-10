import os
import sqlite3
from contextlib import closing
from datetime import UTC, datetime, timedelta

from githubkit import GitHub

REPO = {
    "owner": os.environ.get("OWNER", "openbao"),
    "repo": os.environ.get("REPO", "openbao"),
}


def format_time(timestamp: str) -> str:
    return timestamp[8:10] + "/" + timestamp[5:7] + "/" + timestamp[0:4]


def main(github: GitHub, db: sqlite3.Connection) -> None:
    cutoff_days = 14
    cutoff = (
        (datetime.now(UTC) - timedelta(days=cutoff_days))
        .replace(tzinfo=None)
        .isoformat(timespec="milliseconds")
        .replace("T", "")
    )

    flakes = db.execute(
        """
          SELECT f.package, f.function, c.count, f.timestamp AS last_seen, f.commit_sha, f.pull_request
          FROM (
            SELECT package, function, COUNT(*) AS count, MAX(timestamp) AS last_seen
            FROM failures
            WHERE timestamp > ?
            GROUP BY package, function
          ) c
          JOIN failures f
            ON f.package = c.package
           AND f.function = c.function
           AND f.timestamp = c.last_seen
          ORDER BY c.last_seen DESC, c.count DESC
        """,
        (cutoff,),
    ).fetchall()

    body = f""" 
> [!NOTE]
> This issue is automatically updated every day and provides an overview of flaky tests that have appeared in CI over the past {cutoff_days} days.
>
> Candidates are chosen by selecting CI workflow runs that failed and succeeded after being re-triggered (no pushes can occur inbetween, as that would create an entirely new run). While this approach minimizes false positives, note that many failed runs are not manually retriggered and thus not taken into consideration. As a result, the number of failed runs below is almost guaranteed to be lower than the number of failures technically observable.
>
> We highly appreciate all help in fixing flaky tests! Once a fix has been merged, the test should eventually fade out of the below list.
"""

    for flake in flakes:
        failures = db.execute(
            """
              SELECT run_id, job_id, attempt, timestamp, commit_sha, pull_request FROM failures
              WHERE package = ? AND function = ?
              ORDER BY timestamp DESC
            """,
            (flake["package"], flake["function"]),
        ).fetchall()

        body += "\n---\n\n"
        package = (
            flake["package"]
            .replace("github.com/openbao/openbao/", "", 1)
            .replace("v2/internal", "internal", 1)
            .replace("sdk/v2", "sdk", 1)
            .replace("api/v2", "api", 1)
        )
        body += f"### {flake['function']} ({package})\n\n"
        body += f"Last seen {format_time(flake['last_seen'])}"
        if flake["pull_request"] is not None:
            body += (
                f" in https://github.com/openbao/openbao/pull/{flake['pull_request']}"
            )
        elif flake["commit_sha"]:
            body += (
                f" in https://github.com/openbao/openbao/commit/{flake['commit_sha']}"
            )
        body += "\n\n"

        body += f"```\ngo test {flake['package']} -run '^{flake['function']}$'\n```\n\n"

        suffix = "" if len(failures) == 1 else "s"
        body += (
            f"<details open><summary>{len(failures)} past failure{suffix}:"
            "</summary>\n&nbsp;\n\n"
        )

        body += "| Date | Job | Commit | PR |\n"
        body += "|------|-----|--------|----|\n"
        for failure in failures:
            commit = (
                f"https://github.com/openbao/openbao/commit/{failure['commit_sha']}"
                if failure["commit_sha"] is not None
                else "?"
            )
            pull = (
                f"https://github.com/openbao/openbao/pull/{failure['pull_request']}"
                if failure["pull_request"] is not None
                else "N/A"
            )
            body += (
                f"| {format_time(failure['timestamp'])} | "
                f"[Logs](https://github.com/openbao/openbao/actions/runs/{failure['run_id']}"
                f"/job/{failure['job_id']}?attempt={failure['attempt']}) | "
                f"{commit} | {pull} |\n"
            )
        body += "\n</details>\n"

    if not flakes:
        body += f"No flakes detected in the last {cutoff_days} days!\n"

    github.rest.issues.update(
        owner=REPO["owner"],
        repo=REPO["repo"],
        issue_number=int(os.environ["ISSUE_NUMBER"]),
        body=body,
    )


if __name__ == "__main__":
    with (
        GitHub(
            os.environ.get("GITHUB_TOKEN"),
            user_agent="openbao-flake-tracker/v0.1.0",
        ) as github,
        closing(sqlite3.connect("tests.db", autocommit=True)) as db,
    ):
        db.row_factory = sqlite3.Row
        main(github, db)
