const mongoose = require("mongoose");
const { ObjectId } = mongoose.Types;
const collections = require("../config/collections");
const { writeAuditLog } = require("../services/audit-log.service");

const normalizePaymentMethod = (row) =>
  String(row.PaymentMethod || row.MOP || "")
    .trim()
    .toUpperCase();

const normalizeLineMethod = (value) =>
  String(value || "")
    .trim()
    .toUpperCase();

const normalizeReferenceValue = (value) =>
  String(value || "")
    .replace(/\s+/g, "")
    .trim();

const normalizeCommentValue = (value) => String(value || "").trim();
const normalizeLookupValue = (value) => String(value || "").trim().toUpperCase();

const parseDateValue = (value) => {
  if (!value) return null;

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value;
  }

  const rawValue = String(value).trim();
  if (!rawValue) return null;

  const directDate = new Date(rawValue);
  if (!Number.isNaN(directDate.getTime())) {
    return directDate;
  }

  const slashMatch = rawValue.match(/^(\d{1,4})\/(\d{1,2})\/(\d{1,4})(?:\s+.*)?$/);
  if (slashMatch) {
    const [, part1, part2, part3] = slashMatch;
    let year;
    let month;
    let day;

    if (part1.length === 4) {
      year = Number(part1);
      month = Number(part2);
      day = Number(part3);
    } else {
      month = Number(part1);
      day = Number(part2);
      year = Number(part3);
    }

    const parsed = new Date(year, month - 1, day);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }

  return null;
};

const normalizeRequestedDate = (value) => {
  const rawValue = String(value || "").trim();
  if (!rawValue) return "";

  if (/^\d{4}-\d{2}-\d{2}$/.test(rawValue)) {
    return rawValue;
  }

  const slashMatch = rawValue.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slashMatch) {
    const [, part1, part2, year] = slashMatch;
    const first = Number(part1);
    const second = Number(part2);

    if (first > 12) {
      return `${year}-${String(second).padStart(2, "0")}-${String(first).padStart(2, "0")}`;
    }

    return `${year}-${String(first).padStart(2, "0")}-${String(second).padStart(2, "0")}`;
  }

  const parsed = parseDateValue(rawValue);
  if (!parsed) return "";

  return `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, "0")}-${String(
    parsed.getDate()
  ).padStart(2, "0")}`;
};

const isDateOnRequestedDay = (value, requestedDate) => {
  const parsed = parseDateValue(value);
  if (!parsed) return false;

  const yyyy = parsed.getFullYear();
  const mm = String(parsed.getMonth() + 1).padStart(2, "0");
  const dd = String(parsed.getDate()).padStart(2, "0");

  return `${yyyy}-${mm}-${dd}` === normalizeRequestedDate(requestedDate);
};

const getVerificationDateCandidate = (row) =>
  row?.TransactionDate || row?.PaymentDate || row?.createdAt || null;

const getHistoryReferenceCandidates = (row) =>
  [
    String(row?.Invoice || "").trim(),
    String(row?.PaymentReceipt || "").trim(),
    String(row?.TransactionCode || "").trim()
  ]
    .filter(Boolean)
    .map(normalizeLookupValue);

const buildEarningLookupMap = (rows = []) => {
  const lookup = new Map();

  rows.forEach((row) => {
    getHistoryReferenceCandidates(row).forEach((key) => {
      if (key && !lookup.has(key)) {
        lookup.set(key, row);
      }
    });
  });

  return lookup;
};

const enrichPrintRowWithEarning = (row, earningLookup) => {
  const matchedEarning = getHistoryReferenceCandidates(row)
    .map((key) => earningLookup.get(key))
    .find(Boolean);

  if (!matchedEarning) {
    return row;
  }

  return {
    ...row,
    TransactionDate: matchedEarning?.TransactionDate || row?.TransactionDate || row?.PaymentDate || row?.createdAt,
    PaymentBreakdown:
      (Array.isArray(matchedEarning?.PaymentBreakdown) && matchedEarning.PaymentBreakdown.length
        ? matchedEarning.PaymentBreakdown
        : row?.PaymentBreakdown) || [],
    TransferDate:
      matchedEarning?.TransferDate ||
      matchedEarning?.GCashTransferDate ||
      row?.TransferDate ||
      row?.GCashTransferDate ||
      "",
    GCashTransferDate:
      matchedEarning?.GCashTransferDate ||
      matchedEarning?.TransferDate ||
      row?.GCashTransferDate ||
      row?.TransferDate ||
      "",
    ReceiverLast4:
      matchedEarning?.ReceiverLast4 ||
      matchedEarning?.GCashReceiverLast4 ||
      row?.ReceiverLast4 ||
      row?.GCashReceiverLast4 ||
      "",
    GCashReceiverLast4:
      matchedEarning?.GCashReceiverLast4 ||
      matchedEarning?.ReceiverLast4 ||
      row?.GCashReceiverLast4 ||
      row?.ReceiverLast4 ||
      "",
    PaymentMethod: row?.PaymentMethod || matchedEarning?.MOP || matchedEarning?.PaymentMethod || "",
    MOP: row?.MOP || matchedEarning?.MOP || matchedEarning?.PaymentMethod || "",
    MOPRef: matchedEarning?.MOPRef || row?.MOPRef || "",
    ReferenceNumber: matchedEarning?.MOPRef || row?.ReferenceNumber || row?.MOPRef || ""
  };
};

const getPaymentBreakdownLines = (row) => {
  if (Array.isArray(row?.PaymentBreakdown) && row.PaymentBreakdown.length) {
    return row.PaymentBreakdown
      .map((line) => ({
        Method: normalizeLineMethod(line?.Method || line?.PaymentMethod),
        Amount: Number(line?.Amount || 0),
        Reference: normalizeReferenceValue(line?.Reference),
          TransferDate: normalizeCommentValue(
            line?.TransferDate || line?.DateOfTransfer || line?.GCashTransferDate || row?.TransferDate || row?.GCashTransferDate
          ),
          ReceiverLast4: normalizeCommentValue(
            line?.ReceiverLast4 || line?.GCashReceiverLast4 || row?.ReceiverLast4 || row?.GCashReceiverLast4
          )
        }))
      .filter((line) => line.Method && line.Amount > 0);
  }

  const lines = [];
  const paymentMethod = normalizePaymentMethod(row);
  const cashAmount = Number(row?.CashAmount || 0);
  const gcashAmount = Number(row?.GCashAmount || 0);
  const fallbackReference =
    normalizeReferenceValue(row?.MOPRef) ||
    normalizeReferenceValue(row?.ReferenceNumber) ||
    normalizeReferenceValue(row?.TransactionCode) ||
    normalizeReferenceValue(row?.PaymentReceipt) ||
    normalizeReferenceValue(row?.Invoice);
  const totalAmount = Number(row?.TotalAmount || row?.Cash || 0);

  if (cashAmount > 0) {
    lines.push({
      Method: "CASH",
      Amount: cashAmount,
      Reference: "",
      TransferDate: ""
    });
  }

  if (gcashAmount > 0) {
    lines.push({
      Method: "GCASH",
      Amount: gcashAmount,
      Reference: fallbackReference,
        TransferDate: normalizeCommentValue(row?.TransferDate || row?.GCashTransferDate),
        ReceiverLast4: normalizeCommentValue(row?.ReceiverLast4 || row?.GCashReceiverLast4)
      });
  }

  if (!lines.length && paymentMethod) {
    lines.push({
      Method: paymentMethod,
      Amount: totalAmount,
      Reference: paymentMethod === "CASH" ? "" : fallbackReference,
        TransferDate:
          paymentMethod === "CASH"
            ? ""
            : normalizeCommentValue(row?.TransferDate || row?.GCashTransferDate),
        ReceiverLast4:
          paymentMethod === "CASH"
            ? ""
            : normalizeCommentValue(row?.ReceiverLast4 || row?.GCashReceiverLast4)
      });
  }

  if (!lines.length && fallbackReference && totalAmount > 0) {
    lines.push({
      Method: "GCASH",
      Amount: totalAmount,
      Reference: fallbackReference,
      TransferDate: normalizeCommentValue(row?.TransferDate || row?.GCashTransferDate)
    });
  }

  return lines.filter((line) => line.Amount > 0);
};

const getVerificationLine = (row) =>
  getPaymentBreakdownLines(row).find((line) => line.Method && line.Method !== "CASH") ||
  null;

const isNonCashPayment = (row) => {
  return Boolean(getVerificationLine(row));
};

exports.getPendingTransactions = async (req, res) => {
  try {
    const today = new Date();
    const defaultDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(
      today.getDate()
    ).padStart(2, "0")}`;
    const filter = {
      Type: "Payment",
      Verified: { $ne: true }
    };

    const requestedDate = normalizeRequestedDate(req.query?.date || defaultDate) || defaultDate;
    const start = new Date(`${requestedDate}T00:00:00`);
    if (Number.isNaN(start.getTime())) {
      return res.status(400).json({ error: "Invalid verification date." });
    }

    const db = mongoose.connection.db;
    const [rows, earningRows] = await Promise.all([
      db.collection(collections.print)
        .find(filter)
        .sort({
          PaymentDate: -1,
          TransactionDate: -1,
          createdAt: -1
        })
        .toArray(),
      db.collection(collections.earnings).find({}).toArray()
    ]);

    const earningLookup = buildEarningLookupMap(earningRows);

    const pendingTransactions = rows
      .map((row) => enrichPrintRowWithEarning(row, earningLookup))
      .filter((row) => isDateOnRequestedDay(getVerificationDateCandidate(row), requestedDate))
      .filter(isNonCashPayment)
      .map((row) => {
        const verificationLine = getVerificationLine(row);
        const paymentBreakdown = getPaymentBreakdownLines(row);

        return {
          ...row,
          PaymentMethod: normalizePaymentMethod(row),
          PaymentBreakdown: paymentBreakdown,
          VerificationMethod: verificationLine?.Method || "",
          VerificationAmount: verificationLine?.Amount || 0,
          VerificationTransferDate:
              verificationLine?.TransferDate ||
              normalizeCommentValue(row.TransferDate) ||
              normalizeCommentValue(row.GCashTransferDate) ||
              "",
            VerificationReceiverLast4:
              verificationLine?.ReceiverLast4 ||
              normalizeCommentValue(row.ReceiverLast4) ||
              normalizeCommentValue(row.GCashReceiverLast4) ||
              "",
            VerificationReference:
            verificationLine?.Reference ||
            normalizeReferenceValue(row.MOPRef) ||
            normalizeReferenceValue(row.ReferenceNumber) ||
            normalizeReferenceValue(row.TransactionCode) ||
            normalizeReferenceValue(row.PaymentReceipt) ||
            normalizeReferenceValue(row.Invoice),
          MatchReference:
            verificationLine?.Reference ||
            normalizeReferenceValue(row.MOPRef) ||
            normalizeReferenceValue(row.ReferenceNumber) ||
            normalizeReferenceValue(row.TransactionCode) ||
            normalizeReferenceValue(row.PaymentReceipt) ||
            normalizeReferenceValue(row.Invoice)
        };
      });

    res.json({
      requestedDate,
      count: pendingTransactions.length,
      records: pendingTransactions
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.verifyTransactions = async (req, res) => {
  try {
    const records = Array.isArray(req.body?.records) ? req.body.records : [];

    if (!records.length) {
      return res.status(400).json({ error: "No transaction records were provided." });
    }

    const validRecords = records.filter((record) => ObjectId.isValid(record?.id));

    if (!validRecords.length) {
      return res.status(400).json({ error: "No valid transaction ids were provided." });
    }

    const verifiedBy =
      req.user?.name || req.user?.username || req.user?.Name || req.user?.id || "";
    const verifiedById = req.user?.id || req.user?._id || "";
    const verifiedAt = new Date();

    const operations = validRecords.map((record) => ({
      updateOne: {
        filter: {
          _id: new ObjectId(record.id),
          Verified: { $ne: true }
        },
        update: {
          $set: {
            Verified: true,
            VerifiedAt: verifiedAt,
            VerifiedBy: verifiedBy,
            VerifiedById: verifiedById,
            VerificationMethod: String(record.method || "MANUAL")
              .trim()
              .toUpperCase(),
            VerifiedReference: normalizeReferenceValue(record.reference),
            VerificationComment: normalizeCommentValue(record.comment),
            updatedAt: verifiedAt
          }
        }
      }
    }));

    const result = await mongoose.connection.db
      .collection(collections.print)
      .bulkWrite(operations, { ordered: false });

    res.json({
      success: true,
      matchedCount: result.matchedCount || 0,
      modifiedCount: result.modifiedCount || 0
    });

    await writeAuditLog({
      req,
      module: "TRANSACTION_VERIFICATION",
      action: "VERIFY",
      targetType: "PRINT",
      status: "SUCCESS",
      summary: "Transaction verification completed.",
      details: {
        matchedCount: result.matchedCount || 0,
        modifiedCount: result.modifiedCount || 0
      },
      values: validRecords
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

