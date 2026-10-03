// A second process for the alerts store's concurrency test: `bun writer-child.ts <path>
// <prefix> <count>` adds <count> alerts with ids <prefix>-<n>, one locked edit each.
import { editAlerts } from "../../src/alerts/store.ts";

const [path, prefix, count] = Bun.argv.slice(2) as [string, string, string];
const NOW = Date.UTC(2026, 9, 1, 15);

for (let n = 0; n < Number(count); n++) {
  editAlerts(path, (alerts) => {
    alerts.push({
      id: `${prefix}-${n}`,
      created_at: NOW,
      session: null,
      account: {
        id: "acct",
        label: "personal",
        provider: "claude",
        group: null,
        members: ["acct"],
      },
      window: "5h",
      at: 80,
      note: null,
      delivered: [],
    });
    return true;
  });
}
