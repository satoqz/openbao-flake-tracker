import { DatabaseSync } from "node:sqlite";
import { Octokit } from "octokit";

const db = new DatabaseSync("tests.db");

const REPO = {
  owner: Deno.env.get("OWNER") ?? "openbao",
  repo: Deno.env.get("REPO") ?? "openbao",
};

const octokit = new Octokit({
  userAgent: "openbao-flake-tracker/v0.1.0",
  auth: Deno.env.get("GITHUB_TOKEN"),
});

const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
  .toISOString().replace("T", "").replace("Z", "");

const formatTime = (timestamp: string) =>
  timestamp.slice(8, 10) + "/" + // DD
  timestamp.slice(5, 7) + "/" + // MM
  timestamp.slice(0, 4); // YYYY

const flakes = db.prepare(`
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
`).all(cutoff) as Array<{
  package: string;
  function: string;
  count: number;
  last_seen: string;
  commit_sha: number | null;
  pull_request: number | null;
}>;

let body = ` 
> [!NOTE]
> This issue is automatically updated every day and provides an overview of flaky tests that have appeared in CI over the past 7 days.
>
> Candidates are chosen by selecting CI workflow runs that failed and succeeded after being re-triggered (no pushes can occur inbetween, as that would create an entirely new run). While this approach minimizes false positives, note that many failed runs are not manually retriggered and thus not taken into consideration. As a result, the number of failed runs below is almost guaranteed to be lower than the number of failures technically observable.
>
> We highly appreciate all help in fixing flaky tests! Once a fix has been merged, the test should eventually fade out of the below list.
`;

for (const flake of flakes) {
  const failures = db.prepare(`
      SELECT run_id, job_id, attempt, timestamp, commit_sha, pull_request FROM failures
      WHERE package = ? AND function = ?
      ORDER BY timestamp DESC
    `).all(flake.package, flake.function) as Array<{
    run_id: number;
    job_id: number;
    attempt: number;
    timestamp: string;
    commit_sha: string | null;
    pull_request: number | null;
  }>;

  body += "\n---\n\n";
  body += `### ${flake.function} (${
    flake.package
      .replace("github.com/openbao/openbao/", "")
      .replace("v2/internal", "internal")
      .replace("sdk/v2", "sdk")
      .replace("api/v2", "api")
  })\n\n`;
  body += `Last seen ${formatTime(flake.last_seen)}${
    flake.pull_request != null
      ? ` in https://github.com/openbao/openbao/pull/${flake.pull_request}`
      : flake.commit_sha
      ? ` in https://github.com/openbao/openbao/commit/${flake.commit_sha}`
      : ""
  }\n\n`;

  body +=
    `${"```\n"}go test ${flake.package} -run '^${flake.function}$'${"\n```"}\n\n`;

  body += `<details open><summary>${failures.length} past failure${
    failures.length == 1 ? "" : "s"
  }:</summary>\n&nbsp;\n\n`;

  body += "| Date | Job | Commit | PR |\n";
  body += "|------|-----|--------|----|\n";
  for (const failure of failures) {
    body += `| ${
      formatTime(failure.timestamp)
    } | [Logs](https://github.com/openbao/openbao/actions/runs/${failure.run_id}/job/${failure.job_id}?attempt=${failure.attempt}) | ${
      failure.commit_sha != null
        ? `https://github.com/openbao/openbao/commit/${failure.commit_sha}`
        : "?"
    } | ${
      failure.pull_request != null
        ? `https://github.com/openbao/openbao/pull/${failure.pull_request}`
        : "N/A"
    } |\n`;
  }
  body += "\n</details>\n";
}

if (flakes.length === 0) {
  body += "No flakes detected in the last 30 days!\n";
}

db.close();

await octokit.rest.issues.update({
  ...REPO,
  issue_number: parseInt(Deno.env.get("ISSUE_NUMBER")!, 10),
  body,
});
