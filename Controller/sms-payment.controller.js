const mongoose = require("mongoose");
const collections = require("../config/collections");
const { sendPaymentReceivedSms, sendPaymentReminderSms } = require("../services/sms.service");
const { writeAuditLog } = require("../services/audit-log.service");

exports.sendPaymentReceivedSms = async (req, res) => {
  try {
    console.log("SMS PAYMENT CONTROLLER REQUEST:", {
      accountNumber: req.body?.client?.AccountNumber || "",
      contactNumber: req.body?.client?.ContactNumber || "",
      amountPaid: req.body?.amountPaid || 0
    });

    const result = await sendPaymentReceivedSms({
      client: req.body.client,
      amountPaid: req.body.amountPaid,
      subscriptionCover: req.body.subscriptionCover,
      nextDueDate: req.body.nextDueDate,
      monthlyDue: req.body.monthlyDue
    });

    console.log("SMS PAYMENT CONTROLLER RESULT:", result);
    await writeAuditLog({
      req,
      module: "SMS",
      action: "SEND_PAYMENT_RECEIVED",
      targetType: "SMS",
      accountName: req.body?.client?.AccountName || "",
      status: result?.sent ? "SUCCESS" : "SKIPPED",
      summary: result?.sent
        ? "Payment received SMS sent."
        : "Payment received SMS skipped.",
      details: result,
      values: {
        client: req.body.client,
        amountPaid: req.body.amountPaid,
        subscriptionCover: req.body.subscriptionCover,
        nextDueDate: req.body.nextDueDate,
        monthlyDue: req.body.monthlyDue
      }
    });
    res.json(result);
  } catch (err) {
    console.error("SMS PAYMENT CONTROLLER ERROR:", err.message);
    await writeAuditLog({
      req,
      module: "SMS",
      action: "SEND_PAYMENT_RECEIVED",
      targetType: "SMS",
      accountName: req.body?.client?.AccountName || "",
      status: "FAILED",
      summary: "Payment received SMS failed.",
      details: {
        error: err.message
      },
      values: {
        client: req.body.client,
        amountPaid: req.body.amountPaid
      }
    });
    res.status(500).json({ error: err.message });
  }
};

exports.sendPaymentReminderSms = async (req, res) => {
  try {
    const result = await sendPaymentReminderSms({
      client: req.body.client,
      monthlyDue: req.body.monthlyDue,
      totalAmountDue: req.body.totalAmountDue,
      dueDate: req.body.dueDate,
      subscriptionCover: req.body.subscriptionCover
    });

    await writeAuditLog({
      req,
      module: "SMS",
      action: "SEND_PAYMENT_REMINDER",
      targetType: "SMS",
      accountName: req.body?.client?.AccountName || "",
      status: result?.sent ? "SUCCESS" : "SKIPPED",
      summary: result?.sent
        ? "Payment reminder SMS sent."
        : "Payment reminder SMS skipped.",
      details: result,
      values: {
        client: req.body.client,
        monthlyDue: req.body.monthlyDue,
        totalAmountDue: req.body.totalAmountDue,
        dueDate: req.body.dueDate,
        subscriptionCover: req.body.subscriptionCover
      }
    });

    res.json(result);
  } catch (err) {
    console.error("SMS REMINDER CONTROLLER ERROR:", err.message);
    await writeAuditLog({
      req,
      module: "SMS",
      action: "SEND_PAYMENT_REMINDER",
      targetType: "SMS",
      accountName: req.body?.client?.AccountName || "",
      status: "FAILED",
      summary: "Payment reminder SMS failed.",
      details: {
        error: err.message
      },
      values: {
        client: req.body.client,
        totalAmountDue: req.body.totalAmountDue
      }
    });
    res.status(500).json({ error: err.message });
  }
};

exports.sendLatestPaymentReceivedSms = async (req, res) => {
  try {
    const { clientId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(clientId)) {
      return res.status(400).json({ error: "Invalid client id." });
    }

    const db = mongoose.connection.db;
    const objectId = new mongoose.Types.ObjectId(clientId);
    const client = await db.collection(collections.clients).findOne({ _id: objectId });

    if (!client) {
      return res.status(404).json({ error: "Client not found." });
    }

    const paymentLookupFilter = {
      Type: "Payment",
      $or: [
        { ClientId: clientId },
        { AccountNumber: client.AccountNumber || "__NO_ACCOUNT_NUMBER__" },
        { AccountName: client.AccountName || "__NO_ACCOUNT_NAME__" }
      ]
    };

    const latestPayment = await db
      .collection(collections.print)
      .find(paymentLookupFilter)
      .sort({ TransactionDate: -1, createdAt: -1, _id: -1 })
      .limit(1)
      .next();

    if (!latestPayment) {
      return res.status(404).json({ error: "No payment record found for this client." });
    }

    const result = await sendPaymentReceivedSms({
      client: {
        ClientName: client.ClientName || client.AccountName || "",
        AccountName: client.AccountName || "",
        AccountNumber: client.AccountNumber || "",
        ContactNumber: client.ContactNumber || ""
      },
      amountPaid: Number(latestPayment.TotalAmount || latestPayment.Cash || 0),
      subscriptionCover: latestPayment.Cover || client.SubscriptionCover || "",
      nextDueDate: client.DueDate || latestPayment.NextDueDate || latestPayment.DueDate || "",
      monthlyDue: Number(client.AmountDue || 0)
    });

    await writeAuditLog({
      req,
      module: "SMS",
      action: "RESEND_PAYMENT_RECEIVED",
      targetType: "SMS",
      accountName: client.AccountName || "",
      status: result?.sent ? "SUCCESS" : "SKIPPED",
      summary: result?.sent
        ? "Latest payment received SMS resent."
        : "Latest payment received SMS skipped.",
      details: result,
      values: {
        clientId,
        paymentId: String(latestPayment._id || ""),
        amountPaid: Number(latestPayment.TotalAmount || latestPayment.Cash || 0)
      }
    });

    res.json(result);
  } catch (err) {
    console.error("RESEND PAYMENT RECEIVED SMS ERROR:", err.message);
    await writeAuditLog({
      req,
      module: "SMS",
      action: "RESEND_PAYMENT_RECEIVED",
      targetType: "SMS",
      accountName: req.body?.client?.AccountName || "",
      status: "FAILED",
      summary: "Latest payment received SMS failed.",
      details: {
        error: err.message
      }
    });
    res.status(500).json({ error: err.message });
  }
};
