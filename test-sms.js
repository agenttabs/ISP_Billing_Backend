const mongoose = require("mongoose");
const connectDB = require("./config/db.runtime");
const { sendPaymentReceivedSms } = require("./services/sms.service");

const getArgValue = (flag, fallback = "") => {
  const index = process.argv.indexOf(flag);
  if (index === -1) {
    return fallback;
  }

  return process.argv[index + 1] || fallback;
};

const payload = {
  client: {
    ClientName: getArgValue("--client", "Test Client"),
    AccountName: getArgValue("--account-name", "Test Account"),
    AccountNumber: getArgValue("--account-number", "TEST-0001"),
    ContactNumber: getArgValue("--contact", "09167700957")
  },
  amountPaid: Number(getArgValue("--amount-paid", "1000")),
  monthlyDue: Number(getArgValue("--monthly-due", "1000")),
  subscriptionCover: getArgValue(
    "--subscription-cover",
    "Subscription covered from April 15, 2026 to May 14, 2026"
  ),
  nextDueDate: getArgValue("--next-due-date", new Date().toISOString())
};

const run = async () => {
  try {
    console.log("Connecting to MongoDB...");
    await connectDB();

    console.log("Sending test SMS with payload:");
    console.log(JSON.stringify(payload, null, 2));

    const result = await sendPaymentReceivedSms(payload);

    console.log("SMS test result:");
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error("SMS test failed:");
    console.error(err?.message || err);
    process.exitCode = 1;
  } finally {
    await mongoose.connection.close();
    console.log("MongoDB connection closed.");
  }
};

run();
