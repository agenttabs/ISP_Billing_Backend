const mongoose = require("mongoose");
const collections = require("../config/collections");

const DEFAULT_ZITA_SMS_URL =
  process.env.ZITA_SMS_URL || "https://my.zitasms.com/services/send.php";

const getSmsGatewayConfig = async () => {
  const db = mongoose.connection.db;
  console.log("SMS GATEWAY DB NAME:", db?.databaseName || "(unknown)");

  const candidateCollections = collections.smsGatewayCandidates;
  let collectionRows = [];
  let sourceCollection = "";

  for (const collectionName of candidateCollections) {
    const rows = await db.collection(collectionName).find({}).toArray();

    if (rows.length > 0) {
      collectionRows = rows;
      sourceCollection = collectionName;
      break;
    }
  }

  console.log(
    "SMS GATEWAY COLLECTION ROWS:",
    {
      sourceCollection: sourceCollection || "(none)",
      count: collectionRows.length,
      rows: collectionRows.map((item) => ({
      ServiceName: item.ServiceName ?? item.serviceName ?? "",
      Status: item.Status ?? item.status ?? "",
      API: item.API ?? item.api ?? "",
      SENDERID: item.SENDERID ?? item.senderId ?? item.senderID ?? ""
      }))
    }
  );

  return collectionRows.find((item) => {
    const serviceName = String(
      item.ServiceName || item.serviceName || ""
    ).trim().toUpperCase();
    const status = String(item.Status || item.status || "")
      .trim()
      .toUpperCase();

    return serviceName === "ANDROIDGATEWAY" && status === "YES";
  }) || null;
};

const getSmsTemplateByType = async (type) => {
  const normalizedType = String(type || "").trim().toLowerCase();
  const db = mongoose.connection.db;
  const collectionRows = await db.collection(collections.smsRecipient).find({}).toArray();

  return collectionRows.find(
    (item) => String(item.TYPE || "").trim().toLowerCase() === normalizedType
  );
};

const formatPeso = (value) => Number(value || 0).toLocaleString("en-PH", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
});

const formatDate = (value) => {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";

  return date.toLocaleDateString("en-PH", {
    year: "numeric",
    month: "long",
    day: "numeric"
  });
};

const replaceSmsTokens = (body, values) =>
  Object.entries(values).reduce((message, [key, value]) => {
    const token = `@${key}@`;
    return message.split(token).join(String(value ?? ""));
  }, body);

const normalizeMobileNumber = (value) => {
  return String(value || "").trim();
};

const sendSmsMessage = async ({ recipient, message }) => {
  const normalizedRecipient = normalizeMobileNumber(recipient);
  const normalizedMessage = String(message || "").trim();

  if (!normalizedRecipient) {
    return {
      sent: false,
      reason: "No recipient contact number."
    };
  }

  if (!normalizedMessage) {
    return {
      sent: false,
      reason: "SMS message is empty."
    };
  }

  const gateway = await getSmsGatewayConfig();
  const gatewayApi = gateway?.API || gateway?.api || "";
  const gatewaySenderId =
    gateway?.SENDERID || gateway?.senderId || gateway?.senderID || "";

  if (!gatewayApi || !gatewaySenderId) {
    return {
      sent: false,
      reason: "SMS gateway API or sender id is missing."
    };
  }

  const query = new URLSearchParams({
    key: gatewayApi,
    number: normalizedRecipient,
    message: normalizedMessage,
    devices: gatewaySenderId,
    type: "sms",
    prioritize: "1"
  });
  const requestUrl = `${DEFAULT_ZITA_SMS_URL}?${query.toString()}`;

  const response = await fetch(requestUrl, {
    method: "GET"
  });

  const responseText = await response.text();

  if (!response.ok) {
    throw new Error(`SMS gateway error: ${response.status} ${responseText}`);
  }

  return {
    sent: true,
    response: responseText,
    recipient: normalizedRecipient,
    message: normalizedMessage
  };
};

exports.sendDirectSms = sendSmsMessage;
exports.getSmsTemplateByType = getSmsTemplateByType;
exports.replaceSmsTokens = replaceSmsTokens;

exports.sendPaymentReceivedSms = async ({
  client,
  amountPaid,
  subscriptionCover,
  nextDueDate,
  monthlyDue
}) => {
  const recipient = normalizeMobileNumber(client?.ContactNumber);
  console.log("SMS PAYMENT SEND START:", {
    clientName: client?.ClientName || client?.AccountName || "",
    accountNumber: client?.AccountNumber || "",
    recipient
  });

  if (!recipient) {
    console.log("SMS PAYMENT SKIPPED: no recipient contact number.");
    return {
      sent: false,
      reason: "No client contact number."
    };
  }

  const [gateway, template] = await Promise.all([
    getSmsGatewayConfig(),
    getSmsTemplateByType("paymentreceived")
  ]);

  console.log("SMS PAYMENT GATEWAY:", {
    serviceName: gateway?.ServiceName || gateway?.serviceName || "",
    senderId:
      gateway?.SENDERID || gateway?.senderId || gateway?.senderID || "",
    hasApi: Boolean(gateway?.API || gateway?.api)
  });

  const gatewayApi = gateway?.API || gateway?.api || "";
  const gatewaySenderId =
    gateway?.SENDERID || gateway?.senderId || gateway?.senderID || "";

  if (!gatewayApi || !gatewaySenderId) {
    console.log("SMS PAYMENT SKIPPED: missing API or sender id.");
    return {
      sent: false,
      reason: "SMS gateway API or sender id is missing."
    };
  }

  if (!template?.Body) {
    console.log("SMS PAYMENT SKIPPED: paymentreceived template not found.");
    return {
      sent: false,
      reason: "paymentreceived SMS template not found."
    };
  }

  const message = replaceSmsTokens(template.Body, {
    ClientName: client?.ClientName || client?.AccountName || "",
    AccountNumber: client?.AccountNumber || "",
    MonthlyDue: formatPeso(monthlyDue),
    SubscriptionCover: subscriptionCover || "",
    AmountPaid: formatPeso(amountPaid),
    NextDueDate: formatDate(nextDueDate)
  });

  const result = await sendSmsMessage({
    recipient,
    message
  });

  console.log("SMS PAYMENT SENT:", {
    recipient,
    senderId: gatewaySenderId,
    responseText: result.response || ""
  });

  return result;
};
