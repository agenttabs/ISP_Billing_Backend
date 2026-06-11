const mongoose = require("mongoose");
const collections = require("../config/collections");
const { DEFAULT_COMPANY_NAME, getCompanyName } = require("./system-settings.service");

const DEFAULT_ZITA_SMS_URL =
  process.env.ZITA_SMS_URL || "https://www.zitasms.com/api/send/sms";

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
      ApiUrl: item.ApiUrl ?? item.apiUrl ?? item.URL ?? item.url ?? "",
      Secret: item.Secret ?? item.secret ?? "",
      Mode: item.Mode ?? item.mode ?? "",
      Device: item.Device ?? item.device ?? item.Sim ?? item.sim ?? ""
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

    return status === "YES" && (!serviceName || serviceName === "ZITASMS");
  }) || collectionRows.find((item) => {
    const status = String(item.Status || item.status || "")
      .trim()
      .toUpperCase();
    return status === "YES";
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
  const raw = String(value || "").trim();
  const digits = raw.replace(/\D/g, "");

  if (!digits) return "";
  if (digits.startsWith("63")) return digits;
  if (digits.startsWith("0") && digits.length === 11) return `63${digits.slice(1)}`;
  if (digits.startsWith("9") && digits.length === 10) return `63${digits}`;

  return digits;
};

const parseGatewayResponse = (responseText) => {
  const trimmed = String(responseText || "").trim();

  if (!trimmed) {
    return { raw: "", parsed: null };
  }

  try {
    return {
      raw: trimmed,
      parsed: JSON.parse(trimmed)
    };
  } catch (_error) {
    return {
      raw: trimmed,
      parsed: null
    };
  }
};

const isGatewaySuccess = ({ response, parsedResponse, rawResponse }) => {
  if (!response?.ok) {
    return false;
  }

  if (parsedResponse && typeof parsedResponse === "object") {
    const successFlags = [
      parsedResponse.success,
      parsedResponse.status,
      parsedResponse.sent,
      parsedResponse.result
    ];

    if (
      successFlags.some(
        (value) =>
          value === true ||
          String(value || "").trim().toLowerCase() === "success" ||
          String(value || "").trim().toLowerCase() === "sent" ||
          String(value || "").trim().toLowerCase() === "ok"
      )
    ) {
      return true;
    }

    if (parsedResponse.error || parsedResponse.errors || parsedResponse.message) {
      const text = `${parsedResponse.error || ""} ${parsedResponse.errors || ""} ${parsedResponse.message || ""}`
        .trim()
        .toLowerCase();

      if (
        text.includes("error") ||
        text.includes("invalid") ||
        text.includes("failed") ||
        text.includes("denied")
      ) {
        return false;
      }
    }
  }

  const lowered = String(rawResponse || "").toLowerCase();

  if (
    lowered.includes("error") ||
    lowered.includes("invalid") ||
    lowered.includes("failed") ||
    lowered.includes("denied")
  ) {
    return false;
  }

  if (
    lowered.includes("success") ||
    lowered.includes("sent") ||
    lowered.includes("queued") ||
    lowered.includes("accepted")
  ) {
    return true;
  }

  return response.ok;
};

const buildGatewayConfig = (gateway) => {
  const gatewayUrl =
    gateway?.ApiUrl || gateway?.apiUrl || gateway?.URL || gateway?.url || DEFAULT_ZITA_SMS_URL;
  const gatewaySecret = gateway?.Secret || gateway?.secret || "";
  const gatewayMode = String(gateway?.Mode || gateway?.mode || "devices").trim() || "devices";
  const gatewayDevice = String(
    gateway?.Device || gateway?.device || gateway?.Sim || gateway?.sim || ""
  ).trim();
  const gatewaySim = String(gateway?.Sim || gateway?.sim || "1").trim() || "1";

  return {
    gatewayUrl,
    gatewaySecret,
    gatewayMode,
    gatewayDevice,
    gatewaySim
  };
};

const sendSmsMessage = async ({ recipient, message, gatewayOverride = null }) => {
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

  const gateway = gatewayOverride || (await getSmsGatewayConfig());
  const { gatewayUrl, gatewaySecret, gatewayMode, gatewayDevice, gatewaySim } =
    buildGatewayConfig(gateway);

  if (!gatewaySecret) {
    return {
      sent: false,
      reason: "SMS gateway secret is missing."
    };
  }

  if (!gatewayDevice) {
    return {
      sent: false,
      reason: "SMS gateway device is missing."
    };
  }

  const form = new FormData();
  form.append("secret", gatewaySecret);
  form.append("mode", gatewayMode);
  form.append("phone", normalizedRecipient);
  form.append("message", normalizedMessage);
  form.append("device", gatewayDevice);
  form.append("sim", gatewaySim);

  const response = await fetch(gatewayUrl, {
    method: "POST",
    body: form
  });

  const responseText = await response.text();
  const { raw: rawResponse, parsed: parsedResponse } = parseGatewayResponse(responseText);

  if (!response.ok) {
    throw new Error(`SMS gateway error: ${response.status} ${responseText}`);
  }

  const gatewayAccepted = isGatewaySuccess({
    response,
    parsedResponse,
    rawResponse
  });

  if (!gatewayAccepted) {
    return {
      sent: false,
      reason: rawResponse || "SMS gateway did not accept the message.",
      response: rawResponse,
      parsedResponse,
      recipient: normalizedRecipient,
      message: normalizedMessage
    };
  }

  return {
    sent: true,
    response: rawResponse,
    parsedResponse,
    recipient: normalizedRecipient,
    message: normalizedMessage
  };
};

exports.sendDirectSms = sendSmsMessage;
exports.sendDirectSmsWithGateway = async ({ recipient, message, gateway }) =>
  sendSmsMessage({ recipient, message, gatewayOverride: gateway });
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
    mode: gateway?.Mode || gateway?.mode || "devices",
    device: gateway?.Device || gateway?.device || gateway?.Sim || gateway?.sim || "",
    hasSecret: Boolean(gateway?.Secret || gateway?.secret)
  });

  const gatewaySecret = gateway?.Secret || gateway?.secret || "";
  const gatewayDevice = gateway?.Device || gateway?.device || gateway?.Sim || gateway?.sim || "";

  if (!gatewaySecret) {
    console.log("SMS PAYMENT SKIPPED: missing secret.");
    return {
      sent: false,
      reason: "SMS gateway secret is missing."
    };
  }

  if (!String(gatewayDevice).trim()) {
    console.log("SMS PAYMENT SKIPPED: missing device.");
    return {
      sent: false,
      reason: "SMS gateway device is missing."
    };
  }

  if (!template?.Body) {
    console.log("SMS PAYMENT SKIPPED: paymentreceived template not found.");
    return {
      sent: false,
      reason: "paymentreceived SMS template not found."
    };
  }

  const companyName = await getCompanyName().catch(() => DEFAULT_COMPANY_NAME);
  const message = replaceSmsTokens(template.Body, {
    ClientName: client?.ClientName || client?.AccountName || "",
    CompanyName: companyName,
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
    mode: gateway?.Mode || gateway?.mode || "devices",
    responseText: result.response || ""
  });

  return result;
};

exports.sendPaymentReminderSms = async ({
  client,
  monthlyDue,
  totalAmountDue,
  dueDate,
  subscriptionCover
}) => {
  const recipient = normalizeMobileNumber(client?.ContactNumber);

  if (!recipient) {
    return {
      sent: false,
      reason: "No client contact number."
    };
  }

  const [gateway, template] = await Promise.all([
    getSmsGatewayConfig(),
    getSmsTemplateByType("paymentreminder")
  ]);

  const gatewaySecret = gateway?.Secret || gateway?.secret || "";
  const gatewayDevice =
    gateway?.Device || gateway?.device || gateway?.Sim || gateway?.sim || "";

  if (!gatewaySecret) {
    return {
      sent: false,
      reason: "SMS gateway secret is missing."
    };
  }

  if (!String(gatewayDevice).trim()) {
    return {
      sent: false,
      reason: "SMS gateway device is missing."
    };
  }

  if (!template?.Body) {
    return {
      sent: false,
      reason: "paymentreminder SMS template not found."
    };
  }

  const companyName = await getCompanyName().catch(() => DEFAULT_COMPANY_NAME);
  const message = replaceSmsTokens(template.Body, {
    ClientName: client?.ClientName || client?.AccountName || "",
    CompanyName: companyName,
    AccountNumber: client?.AccountNumber || "",
    MonthlyDue: formatPeso(monthlyDue),
    SubscriptionCover: subscriptionCover || "",
    AmountPaid: "",
    NextDueDate: formatDate(dueDate),
    TotalAmountDue: formatPeso(totalAmountDue),
    DueDate: formatDate(dueDate)
  });

  return sendSmsMessage({
    recipient,
    message
  });
};

exports.sendPaymentCorrectionSms = async ({
  client,
  dueDate,
  subscriptionCover
}) => {
  const recipient = normalizeMobileNumber(client?.ContactNumber);

  if (!recipient) {
    return {
      sent: false,
      reason: "No client contact number."
    };
  }

  const [gateway, template] = await Promise.all([
    getSmsGatewayConfig(),
    getSmsTemplateByType("paymentcorrection")
  ]);

  const gatewaySecret = gateway?.Secret || gateway?.secret || "";
  const gatewayDevice =
    gateway?.Device || gateway?.device || gateway?.Sim || gateway?.sim || "";

  if (!gatewaySecret) {
    return {
      sent: false,
      reason: "SMS gateway secret is missing."
    };
  }

  if (!String(gatewayDevice).trim()) {
    return {
      sent: false,
      reason: "SMS gateway device is missing."
    };
  }

  if (!template?.Body) {
    return {
      sent: false,
      reason: "paymentcorrection SMS template not found."
    };
  }

  const companyName = await getCompanyName().catch(() => DEFAULT_COMPANY_NAME);
  const message = replaceSmsTokens(template.Body, {
    ClientName: client?.ClientName || client?.AccountName || "",
    CompanyName: companyName,
    AccountNumber: client?.AccountNumber || "",
    SubscriptionCover: subscriptionCover || client?.SubscriptionCover || "",
    DueDate: formatDate(dueDate),
    NextDueDate: formatDate(dueDate),
    MonthlyDue: formatPeso(client?.AmountDue || 0)
  });

  return sendSmsMessage({
    recipient,
    message
  });
};
