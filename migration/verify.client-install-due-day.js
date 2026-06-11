require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const mongoose = require("mongoose");
const collections = require("../config/collections");
const { MONGO_URI, MONGOOSE_OPTIONS } = require("../config/mongo");

const limitArg = process.argv.find((arg) => arg.startsWith("--limit="));
const limit = limitArg ? Math.max(Number(limitArg.split("=")[1]) || 0, 0) : 0;
const installDateFrom = new Date(2026, 3, 1, 0, 0, 0, 0);
const installDateTo = new Date();
installDateTo.setHours(23, 59, 59, 999);

const parseDateValue = (value) => {
  if (!value) {
    return null;
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  const text = String(value).trim();
  if (!text) {
    return null;
  }

  const mmddyyyy = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mmddyyyy) {
    const month = Number(mmddyyyy[1]) - 1;
    const day = Number(mmddyyyy[2]);
    const year = Number(mmddyyyy[3]);
    const parsed = new Date(year, month, day, 12, 0, 0, 0);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const getInstallationDateValue = (client) =>
  client.DateEntry || client.DateInstalled || client.InstallDate || client.createdAt || null;

const formatDate = (value) => {
  const parsed = parseDateValue(value);
  if (!parsed) {
    return "-";
  }

  return parsed.toLocaleDateString("en-PH", {
    year: "numeric",
    month: "long",
    day: "numeric"
  });
};

const formatClientLine = ({ client, installDate, dueDate }) => [
  `id=${client._id}`,
  `account="${client.AccountName || client.accountName || "-"}"`,
  `client="${client.ClientName || client.clientName || "-"}"`,
  `install="${formatDate(installDate)}"`,
  `installDay=${installDate.getDate()}`,
  `due="${formatDate(dueDate)}"`,
  `dueDay=${dueDate.getDate()}`,
  `status="${client.Status || client.status || "-"}"`,
  `plan="${client.NetPlan || client.Profile || client.plan || "-"}"`
].join(" | ");

async function main() {
  await mongoose.connect(MONGO_URI, MONGOOSE_OPTIONS);

  const clients = mongoose.connection.db.collection(collections.clients);
  const cursor = clients
    .find(
      {},
      {
        projection: {
          _id: 1,
          AccountName: 1,
          accountName: 1,
          ClientName: 1,
          clientName: 1,
          DateEntry: 1,
          DateInstalled: 1,
          InstallDate: 1,
          DueDate: 1,
          dueDate: 1,
          Status: 1,
          status: 1,
          NetPlan: 1,
          Profile: 1,
          plan: 1,
          createdAt: 1
        }
      }
    )
    .sort({ AccountName: 1, ClientName: 1, _id: 1 });

  let checkedCount = 0;
  let matchedCount = 0;
  let mismatchCount = 0;
  let outsideInstallRangeCount = 0;
  let missingInstallDateCount = 0;
  let missingDueDateCount = 0;
  let listedCount = 0;

  console.log("Checking client installation day vs due-date day...");
  console.log(
    `Installation date range: ${formatDate(installDateFrom)} to ${formatDate(installDateTo)}`
  );
  console.log("Listing clients where installation day and due-date day are different.\n");

  for await (const client of cursor) {
    checkedCount += 1;

    const installDate = parseDateValue(getInstallationDateValue(client));
    const dueDate = parseDateValue(client.DueDate || client.dueDate);

    if (!installDate) {
      missingInstallDateCount += 1;
      continue;
    }

    if (installDate < installDateFrom || installDate > installDateTo) {
      outsideInstallRangeCount += 1;
      continue;
    }

    if (!dueDate) {
      missingDueDateCount += 1;
      continue;
    }

    if (installDate.getDate() === dueDate.getDate()) {
      matchedCount += 1;
      continue;
    }

    mismatchCount += 1;

    if (!limit || listedCount < limit) {
      console.log(formatClientLine({ client, installDate, dueDate }));
      listedCount += 1;
    }
  }

  console.log("\nSummary");
  console.log(`Checked: ${checkedCount}`);
  console.log(`Outside install date range: ${outsideInstallRangeCount}`);
  console.log(`Same day: ${matchedCount}`);
  console.log(`Different day: ${mismatchCount}`);
  console.log(`Missing installation date: ${missingInstallDateCount}`);
  console.log(`Missing due date: ${missingDueDateCount}`);

  if (limit && mismatchCount > listedCount) {
    console.log(`Listed: ${listedCount} of ${mismatchCount} different-day client(s).`);
    console.log("Run without --limit to list all different-day clients.");
  }
}

main()
  .catch((error) => {
    console.error("VERIFY CLIENT INSTALL/DUE DAY ERROR:", error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => {});
  });
