const dotenv = require("dotenv");

dotenv.config();

const parseCollectionList = (value, fallback) => {
  const source = String(value || fallback || "");
  return source
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
};

const collections = {
  clients: process.env.CLIENTS_COLLECTION || "clients",
  netPlans: process.env.NETPLANS_COLLECTION || "NetPlan",
  installations: process.env.INSTALLATIONS_COLLECTION || "Installations",
  servers: process.env.SERVERS_COLLECTION || "Servers",
  credentials: process.env.CREDENTIALS_COLLECTION || "credential",
  emailNotification: process.env.EMAIL_NOTIFICATION_COLLECTION || "EmailNotification",
  printReceipt: process.env.PRINT_RECEIPT_COLLECTION || "PrintReceipt",
  systemSettings: process.env.SYSTEM_SETTINGS_COLLECTION || "SystemSettings",
  mikrotikChecker: process.env.MIKROTIK_CHECKER_COLLECTION || "MikrotikChecker",
  mikrotikDcBatch: process.env.MIKROTIK_DC_BATCH_COLLECTION || "MikrotikDcBatch",
  oltDumpScheduler: process.env.OLT_DUMP_SCHEDULER_COLLECTION || "OltDumpScheduler",
  mikrotikDueDisconnectBatch:
    process.env.MIKROTIK_DUE_DISCONNECT_BATCH_COLLECTION || "MikrotikDueDisconnectBatch",
  systemLogs: process.env.SYSTEM_LOGS_COLLECTION || "SystemLogs",
  gmail: process.env.GMAIL_COLLECTION || "Gmail",
  print: process.env.PRINT_COLLECTION || "print",
  earnings: process.env.EARNINGS_COLLECTION || "Earnings",
  expense: process.env.EXPENSE_COLLECTION || "Expenses",
  nap: process.env.NAP_COLLECTION || "NAP",
  clientBypass: process.env.CLIENT_BYPASS_COLLECTION || "ClientBypass",
  smsBatchProgram: process.env.SMS_BATCH_PROGRAM_COLLECTION || "SMSBatchProgram",
  smsRecipient: process.env.SMS_RECIPIENT_COLLECTION || "smsrecepient",
  smsGatewayCandidates: parseCollectionList(
    process.env.SMS_GATEWAY_COLLECTIONS,
    "SmsGateway,smsgateway"
  )
};

module.exports = collections;
