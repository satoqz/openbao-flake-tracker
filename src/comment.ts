import { DatabaseSync } from "node:sqlite";
import { Octokit } from "octokit";

const db = new DatabaseSync("tests.db");

const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
  .toISOString().replace("T", "").replace("Z", "");

const formatTime = (timestamp: string) =>
  timestamp.slice(8, 10) + "/" + // DD
  timestamp.slice(5, 7) + "/" + // MM
  timestamp.slice(0, 4); // YYYY

const flakes = db.prepare(`
  SELECT package, function, COUNT(*) as count, MAX(timestamp) as last_seen
  FROM failures
  WHERE timestamp > ?
  GROUP BY package, function
  ORDER BY count DESC
`).all(thirtyDaysAgo) as Array<{
  package: string;
  function: string;
  count: number;
  last_seen: string;
}>;

let body = ` 
> [!NOTE]
> This issue is automatically updated every day and provides an overview of
> flaky tests that have appeared in CI over the past 30 days.
>
> Candidates are chosen by selecting CI workflow runs that failed and succeeded
> after being re-triggered (no pushes can occur inbetween, as that would
> create an entirely new run). While this approach minimizes false positives,
> note that many failed runs are not manually retriggered and thus not taken
> into consideration. As a result, the number of failed runs below is almost
> guaranteed to be lower than the number of failures technically observable.
>
> We highly appreciate all help in fixing flaky tests! Once a fix has been
> merged, the test should eventually fade out of the below list within 30 days
> at most.
---
`;

for (const flake of flakes) {
  const failures = db.prepare(`
      SELECT run_id, job_id, attempt, timestamp FROM failures
      WHERE package = ? AND function = ? AND timestamp > ?
      ORDER BY timestamp DESC
    `).all(flake.package, flake.function, thirtyDaysAgo) as Array<{
    run_id: number;
    job_id: number;
    attempt: number;
    timestamp: string;
  }>;

  body += `### ${flake.function}\n\n`;
  body += `**Package:** \`${
    flake.package.replace("github.com/openbao/openbao/", "")
  }\`\n`;
  body += `**Last seen:** ${formatTime(flake.last_seen)}\n\n`;

  body += `<details><summary>View ${failures.length} failed job${
    failures.length == 1 ? "" : "s"
  }</summary>\n\n`;
  body += "| Date | Job ID | Link |\n";
  body += "|------|--------|------|\n";
  for (const failure of failures) {
    body += `| ${
      formatTime(failure.timestamp)
    } | ${failure.job_id} | [Click here](https://github.com/openbao/openbao/actions/runs/${failure.run_id}/job/${failure.job_id}?attempt=${failure.attempt}) |\n`;
  }
  body += "\n</details>\n\n";
}

if (flakes.length === 0) {
  body += "No flakes detected in the last 30 days. Happy coding!\n";
}

db.close();

const REPO = { owner: "openbao", repo: "openbao" };

const octokit = new Octokit({
  userAgent: "openbao-flake-database/v0.1.0",
  auth: Deno.env.get("GITHUB_TOKEN"),
});

await octokit.rest.issues.update({
  ...REPO,
  issue_number: parseInt(Deno.env.get("ISSUE_NUMBER")! || "1", 10),
  body,
});
