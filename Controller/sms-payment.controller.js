const { sendPaymentReceivedSms } = require("../services/sms.service");
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
