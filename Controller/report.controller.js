const mongoose = require("mongoose");
const { ObjectId } = mongoose.Types;
const collections = require("../config/collections");
const { writeAuditLog } = require("../services/audit-log.service");

const isDisconnectedClient = (client) => {
  const planValue = String(
    client.NetPlan ?? client.Profile ?? client.Plan ?? ""
  ).toUpperCase();
  const statusValue = String(client.Status ?? client.status ?? "").toUpperCase();
  const amountValue = Number(client.AmountDue ?? client.amountDue ?? NaN);

  return (
    planValue.includes("DISCONNECTION") ||
    planValue.includes("DISCONNECTED") ||
    statusValue.includes("DISCONNECTION") ||
    statusValue.includes("DISCONNECTED") ||
    amountValue === 0
  );
};

const getTodayRange = () => {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
  return { start, end };
};

const getDateRangeFilter = (fieldName, startDate, endDate) => {
  const filter = {};
  const dateFilter = {};

  if (startDate) {
    dateFilter.$gte = new Date(`${startDate}T00:00:00`);
  }

  if (endDate) {
    dateFilter.$lte = new Date(`${endDate}T23:59:59.999`);
  }

  if (Object.keys(dateFilter).length > 0) {
    filter[fieldName] = dateFilter;
  }

  return filter;
};

const getTransactionDateValue = (row) =>
  new Date(row.TransactionDate || row.PaymentDate || row.createdAt || Date.now());

const getEarningTransactionDateValue = (row) =>
  new Date(row.TransactionDate || row.createdAt || Date.now());

const getExpenseTransactionDateValue = (row) =>
  new Date(row.LogDate || row.createdAt || row.updatedAt || Date.now());

const getClientInstallDateValue = (client) => {
  const candidates = [
    client?.DateEntry,
    client?.DateInstalled,
    client?.InstallDate,
    client?.createdAt
  ];

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }

    const parsed = new Date(candidate);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }

  return new Date(0);
};

const getRepairLogDateValue = (row) =>
  new Date(row?.createdAt || row?.updatedAt || Date.now());

const normalizeAccountNumber = (value) =>
  String(value || "").replace(/\s+/g, "").trim();

const normalizeReferenceValue = (value) =>
  String(value || "")
    .replace(/\s+/g, "")
    .trim()
    .toUpperCase();

const normalizePaymentMethod = (value) =>
  String(value || "")
    .trim()
    .toUpperCase();

const getPaymentBreakdownLines = (row) => {
  if (Array.isArray(row?.PaymentBreakdown) && row.PaymentBreakdown.length) {
    return row.PaymentBreakdown
      .map((line) => ({
        Method: normalizePaymentMethod(line?.Method || line?.PaymentMethod),
        Amount: Number(line?.Amount || 0),
        Reference: normalizeReferenceValue(line?.Reference),
        ReceiptAmount: Number(line?.ReceiptAmount || line?.Amount || 0)
      }))
      .filter((line) => line.Method && line.Amount > 0);
  }

  const paymentMethod = normalizePaymentMethod(row?.PaymentMethod || row?.MOP);
  if (!paymentMethod) {
    return [];
  }

  return [
    {
      Method: paymentMethod,
      Amount: Number(row?.TotalAmount || row?.Cash || 0),
      Reference:
        paymentMethod === "CASH"
          ? ""
          : normalizeReferenceValue(
              row?.MOPRef || row?.ReferenceNumber || row?.TransactionCode || ""
            ),
      ReceiptAmount: Number(row?.ReceiptAmount || row?.TotalAmount || row?.Cash || 0)
    }
  ].filter((line) => line.Amount > 0);
};

const getTopLevelPaymentFields = (row) => {
  const paymentBreakdown = getPaymentBreakdownLines(row);
  const uniqueMethods = [...new Set(paymentBreakdown.map((line) => line.Method).filter(Boolean))];
  const nonCashReferences = paymentBreakdown
    .filter((line) => line.Method !== "CASH" && line.Reference)
    .map((line) => line.Reference);
  const uniqueNonCashReferences = [...new Set(nonCashReferences)];

  return {
    PaymentBreakdown: paymentBreakdown,
    PaymentMethod:
      uniqueMethods.length === 1
        ? uniqueMethods[0]
        : paymentBreakdown.length > 1
          ? "MULTIPLE"
          : normalizePaymentMethod(row?.PaymentMethod || row?.MOP) || "CASH",
    ReferenceNumber:
      uniqueNonCashReferences.length === 1
        ? uniqueNonCashReferences[0]
        : "",
    MOPRef:
      uniqueNonCashReferences.length === 1
        ? uniqueNonCashReferences[0]
        : ""
  };
};

const formatPrDate = (date) => {
  const targetDate = new Date(date || Date.now());
  const year = targetDate.getFullYear();
  const month = String(targetDate.getMonth() + 1).padStart(2, "0");
  const day = String(targetDate.getDate()).padStart(2, "0");
  return `${year}${month}${day}`;
};

const getNextPrNumberFromRows = (rows, datePart) => {
  const prefix = `PR-${datePart}-`;
  let highestSequence = 0;

  rows.forEach((row) => {
    const candidates = [
      String(row.Invoice || "").trim(),
      String(row.PaymentReceipt || "").trim(),
      String(row.TransactionCode || "").trim()
    ];

    candidates.forEach((value) => {
      if (!value.startsWith(prefix)) {
        return;
      }

      const sequencePart = value.slice(prefix.length);
      const sequenceNumber = Number(sequencePart);

      if (Number.isFinite(sequenceNumber) && sequenceNumber > highestSequence) {
        highestSequence = sequenceNumber;
      }
    });
  });

  return `${prefix}${String(highestSequence + 1).padStart(4, "0")}`;
};

const mergeHistoryRows = (...rowGroups) => {
  const seen = new Set();

  return rowGroups
    .flat()
    .filter(Boolean)
    .filter((row) => {
      const key = [
        normalizeAccountNumber(row.AccountNumber),
        String(row.Invoice || "").trim(),
        String(row.PaymentReceipt || "").trim(),
        String(row.TransactionDate || row.PaymentDate || row.createdAt || "").trim(),
        String(row.TotalAmount || "").trim(),
        String(row.Type || "").trim()
      ].join("|");

      if (seen.has(key)) {
        return false;
      }

      seen.add(key);
      return true;
    });
};

exports.getDashboardSummary = async (_req, res) => {
  try {
    const clients = await mongoose.connection.db
      .collection(collections.clients)
      .find({})
      .toArray();

    const activeClients = clients.filter((client) => !isDisconnectedClient(client));
    const pppoeCount = activeClients.filter(
      (client) => String(client.AuthenticationMode || "").toUpperCase() === "PPPOE"
    ).length;
    const ipoeCount = activeClients.filter(
      (client) => String(client.AuthenticationMode || "").toUpperCase() === "IPOE"
    ).length;

    res.json({
      activeClients: activeClients.length,
      pppoeClients: pppoeCount,
      ipoeClients: ipoeCount,
      totalClients: clients.length
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.getTransactions = async (req, res) => {
  try {
    const db = mongoose.connection.db;
    const printCollection = db.collection(collections.print);
    const requestedAccountNumber = normalizeAccountNumber(req.query.accountNumber);
    let printRows = [];

    try {
      printRows = await printCollection.find({}).toArray();
    } catch (err) {
      console.warn("PRINT COLLECTION QUERY WARNING:", err.message);
      printRows = [];
    }

    const printHistoryRows = printRows.map((row) => ({
      ...row,
      HistorySource: "print"
    }));

    let filteredTransactions = mergeHistoryRows(printHistoryRows).filter((row) => {
      const rowAccountNumber = normalizeAccountNumber(row.AccountNumber);
      return !requestedAccountNumber || rowAccountNumber === requestedAccountNumber;
    });

    if (String(req.user.type || req.user.role || "").toUpperCase() === "CASHIER" && !requestedAccountNumber) {
      const { start, end } = getTodayRange();
      filteredTransactions = filteredTransactions.filter((row) => {
        const transactionDate = getTransactionDateValue(row);
        return transactionDate >= start && transactionDate <= end;
      });
    } else if (req.query.startDate || req.query.endDate) {
      const start = req.query.startDate
        ? new Date(`${req.query.startDate}T00:00:00`)
        : null;
      const end = req.query.endDate
        ? new Date(`${req.query.endDate}T23:59:59.999`)
        : null;

      filteredTransactions = filteredTransactions.filter((row) => {
        const transactionDate = getTransactionDateValue(row);
        if (start && transactionDate < start) return false;
        if (end && transactionDate > end) return false;
        return true;
      });
    }

    filteredTransactions.sort(
      (a, b) => getTransactionDateValue(b) - getTransactionDateValue(a)
    );

    await writeAuditLog({
      req,
      module: "REPORT",
      action: "GET_TRANSACTIONS",
      targetType: "PRINT",
      status: "SUCCESS",
      summary: "Transaction report generated.",
      details: {
        accountNumber: requestedAccountNumber,
        startDate: req.query.startDate || "",
        endDate: req.query.endDate || "",
        rowCount: filteredTransactions.length
      }
    });

    res.json(filteredTransactions);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.createTransaction = async (req, res) => {
  try {
    const normalizedPaymentFields = getTopLevelPaymentFields(req.body);
    const payload = {
      ...req.body,
      ...normalizedPaymentFields,
      ClientId: req.body.ClientId || "",
      Type: req.body.Type || "Payment",
      MOP: normalizedPaymentFields.PaymentMethod,
      Verified: typeof req.body.Verified === "boolean" ? req.body.Verified : false,
      TransactionDate: req.body.TransactionDate
        ? new Date(req.body.TransactionDate)
        : new Date(),
      PaymentDate: req.body.PaymentDate ? new Date(req.body.PaymentDate) : undefined,
      DueDate: req.body.DueDate ? new Date(req.body.DueDate) : undefined,
      createdAt: req.body.createdAt ? new Date(req.body.createdAt) : new Date(),
      updatedAt: new Date()
    };

    const result = await mongoose.connection.db
      .collection(collections.print)
      .insertOne(payload);

    res.status(201).json({
      _id: result.insertedId,
      ...payload
    });

    await writeAuditLog({
      req,
      module: "TRANSACTION",
      action: "CREATE",
      targetType: "PRINT",
      targetId: result.insertedId,
      accountName: payload.AccountName || "",
      status: "SUCCESS",
      summary: "Payment transaction saved to print collection.",
      values: {
        Type: payload.Type,
        PaymentMethod: payload.PaymentMethod,
        MOPRef: payload.MOPRef,
        ReferenceNumber: payload.ReferenceNumber,
        Invoice: payload.Invoice,
        PaymentReceipt: payload.PaymentReceipt,
        TotalAmount: payload.TotalAmount,
        PaymentBreakdown: payload.PaymentBreakdown
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.createEarning = async (req, res) => {
  try {
    const payload = {
      ...req.body,
      TransactionDate: req.body.TransactionDate
        ? new Date(req.body.TransactionDate)
        : new Date(),
      createdAt: req.body.createdAt ? new Date(req.body.createdAt) : new Date(),
      updatedAt: new Date()
    };

    const result = await mongoose.connection.db
      .collection(collections.earnings)
      .insertOne(payload);

    res.status(201).json({
      _id: result.insertedId,
      ...payload
    });

    await writeAuditLog({
      req,
      module: "EARNING",
      action: "CREATE",
      targetType: "EARNING",
      targetId: result.insertedId,
      accountName: payload.AccountName || "",
      status: "SUCCESS",
      summary: "Earning record saved.",
      values: payload
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.getNextPaymentReceiptNumber = async (req, res) => {
  try {
    const requestedDate = req.query.date
      ? new Date(`${req.query.date}T00:00:00`)
      : new Date();

    if (Number.isNaN(requestedDate.getTime())) {
      return res.status(400).json({ error: "Invalid payment date." });
    }

    const db = mongoose.connection.db;
    const transactions = await db.collection(collections.print).find({}).toArray();
    const earnings = await db.collection(collections.earnings).find({}).toArray();
    const datePart = formatPrDate(requestedDate);
    const nextNumber = getNextPrNumberFromRows(
      [...transactions, ...earnings],
      datePart
    );

    res.json({ receiptNumber: nextNumber });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.validatePaymentReferences = async (req, res) => {
  try {
    const entries = Array.isArray(req.body?.entries) ? req.body.entries : [];

    if (!entries.length) {
      return res.json({
        valid: true,
        refs: []
      });
    }

    const normalizedEntries = entries
      .map((entry) => ({
        method: normalizePaymentMethod(entry?.method),
        amount: Number(entry?.amount || 0),
        reference: normalizeReferenceValue(entry?.reference),
        receiptAmount: Number(entry?.receiptAmount || entry?.amount || 0)
      }))
      .filter((entry) => entry.method && entry.method !== "CASH" && entry.amount > 0 && entry.reference);

    if (!normalizedEntries.length) {
      return res.json({
        valid: true,
        refs: []
      });
    }

    const rows = await mongoose.connection.db
      .collection(collections.print)
      .find({ Type: "Payment" })
      .toArray();

    const existingUsageByRef = new Map();
    const maxReceiptAmountByRef = new Map();
    const existingAccountsByRef = new Map();

    rows.forEach((row) => {
      getPaymentBreakdownLines(row)
        .filter((line) => line.Method !== "CASH" && line.Reference)
        .forEach((line) => {
          const currentUsed = existingUsageByRef.get(line.Reference) || 0;
          existingUsageByRef.set(line.Reference, currentUsed + Number(line.Amount || 0));

          const currentMax = maxReceiptAmountByRef.get(line.Reference) || 0;
          maxReceiptAmountByRef.set(
            line.Reference,
            Math.max(currentMax, Number(line.ReceiptAmount || line.Amount || 0))
          );

          const existingAccounts = existingAccountsByRef.get(line.Reference) || new Set();
          const accountName = String(
            row?.AccountName || row?.ClientName || row?.AccountNumber || ""
          ).trim();

          if (accountName) {
            existingAccounts.add(accountName);
          }

          existingAccountsByRef.set(line.Reference, existingAccounts);
        });
    });

    const requestTotalsByRef = new Map();
    normalizedEntries.forEach((entry) => {
      requestTotalsByRef.set(
        entry.reference,
        (requestTotalsByRef.get(entry.reference) || 0) + entry.amount
      );

      const currentMax = maxReceiptAmountByRef.get(entry.reference) || 0;
      maxReceiptAmountByRef.set(
        entry.reference,
        Math.max(currentMax, Number(entry.receiptAmount || entry.amount || 0))
      );
    });

    const results = [...requestTotalsByRef.entries()].map(([reference, requestedAmount]) => {
      const usedAmount = Number(existingUsageByRef.get(reference) || 0);
      const receiptAmount = Number(maxReceiptAmountByRef.get(reference) || requestedAmount || 0);
      const combinedAmount = usedAmount + requestedAmount;
      const exceeds = combinedAmount > receiptAmount;

      return {
        reference,
        usedAmount,
        requestedAmount,
        receiptAmount,
        combinedAmount,
        exceeds,
        remainingAmount: Math.max(receiptAmount - usedAmount, 0),
        usedByAccounts: [...(existingAccountsByRef.get(reference) || new Set())]
      };
    });

    const exceeded = results.find((item) => item.exceeds);

    if (exceeded) {
      const usedByText = exceeded.usedByAccounts?.length
        ? ` Used by account(s): ${exceeded.usedByAccounts.join(", ")}.`
        : "";

      return res.status(400).json({
        error: `Reference ${exceeded.reference} exceeds the receipt amount. Used: ${exceeded.usedAmount.toFixed(2)}, current: ${exceeded.requestedAmount.toFixed(2)}, receipt: ${exceeded.receiptAmount.toFixed(2)}.${usedByText}`,
        valid: false,
        refs: results
      });
    }

    res.json({
      valid: true,
      refs: results
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.getEarnings = async (req, res) => {
  try {
    const db = mongoose.connection.db;
    const earningsCollection = db.collection(collections.earnings);
    const userType = String(req.user.type || req.user.role || "").toUpperCase();
    const earnings = await earningsCollection.find({}).toArray();

    let filteredEarnings = earnings;

    if (userType === "CASHIER") {
      const { start, end } = getTodayRange();
      filteredEarnings = filteredEarnings.filter((row) => {
        const transactionDate = getEarningTransactionDateValue(row);
        return transactionDate >= start && transactionDate <= end;
      });
    } else if (req.query.startDate || req.query.endDate) {
      const start = req.query.startDate
        ? new Date(`${req.query.startDate}T00:00:00`)
        : null;
      const end = req.query.endDate
        ? new Date(`${req.query.endDate}T23:59:59.999`)
        : null;

      filteredEarnings = filteredEarnings.filter((row) => {
        const transactionDate = getEarningTransactionDateValue(row);
        if (start && transactionDate < start) return false;
        if (end && transactionDate > end) return false;
        return true;
      });
    }

    filteredEarnings.sort((a, b) => {
      const dateA = getEarningTransactionDateValue(a);
      const dateB = getEarningTransactionDateValue(b);
      return dateB - dateA;
    });

    await writeAuditLog({
      req,
      module: "REPORT",
      action: "GET_EARNINGS",
      targetType: "EARNING",
      status: "SUCCESS",
      summary: "Earnings report generated.",
      details: {
        startDate: req.query.startDate || "",
        endDate: req.query.endDate || "",
        rowCount: filteredEarnings.length
      }
    });

    res.json(filteredEarnings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.getExpensesAndEarnings = async (req, res) => {
  try {
    const db = mongoose.connection.db;
    const earningsCollection = db.collection(collections.earnings);
    const expenseCollection = db.collection(collections.expense);
    const userType = String(req.user.type || req.user.role || "").toUpperCase();
    const earnings = await earningsCollection.find({}).toArray();
    const expenses = await expenseCollection.find({}).toArray();

    let start = null;
    let end = null;

    if (userType === "CASHIER") {
      const range = getTodayRange();
      start = range.start;
      end = range.end;
    } else if (req.query.startDate || req.query.endDate) {
      start = req.query.startDate
        ? new Date(`${req.query.startDate}T00:00:00`)
        : null;
      end = req.query.endDate
        ? new Date(`${req.query.endDate}T23:59:59.999`)
        : null;
    }

    const earningRows = earnings
      .filter((row) => {
        const transactionDate = getEarningTransactionDateValue(row);
        if (start && transactionDate < start) return false;
        if (end && transactionDate > end) return false;
        return true;
      })
      .map((row) => ({
        _id: `earning-${row._id}`,
        Source: "EARNING",
        EntryType: "CREDIT",
        TransactionDate: getEarningTransactionDateValue(row),
        Invoice: row.Invoice || "-",
        Name: row.Item || row.ClientName || row.Name || "-",
        AccountName: row.AccountName || "-",
        CreatedBy: row.DeclaredBy || row.CreatedBy || row.CreatedById || "-",
        CreditAmount: Number(row.Cash || row.TotalAmount || 0),
        DebitAmount: 0,
        Type: row.MOP || row.Type || "Earning",
        Reference: row.ReferenceNumber || row.MOPRef || "-"
      }));

    const expenseRows = expenses
      .filter((row) => {
        const transactionDate = getExpenseTransactionDateValue(row);
        if (start && transactionDate < start) return false;
        if (end && transactionDate > end) return false;
        return true;
      })
      .map((row) => ({
        _id: `expense-${row._id}`,
        Source: "EXPENSE",
        EntryType: "DEBIT",
        TransactionDate: getExpenseTransactionDateValue(row),
        Invoice: row.Invoice || "-",
        Name: row.Name || "-",
        AccountName: "-",
        CreatedBy: row.InCharge || "-",
        CreditAmount: 0,
        DebitAmount: Number(String(row.Amount || 0).replace(/,/g, "")) || 0,
        Type: row.Type || "Expense",
        Reference: row.Docs || "-"
      }));

    const rows = [...earningRows, ...expenseRows].sort(
      (a, b) => b.TransactionDate - a.TransactionDate
    );

    const totalCredit = rows.reduce((sum, row) => sum + Number(row.CreditAmount || 0), 0);
    const totalDebit = rows.reduce((sum, row) => sum + Number(row.DebitAmount || 0), 0);

    await writeAuditLog({
      req,
      module: "REPORT",
      action: "GET_EXPENSES_AND_EARNINGS",
      targetType: "EARNING_AND_EXPENSE",
      status: "SUCCESS",
      summary: "Expenses and earnings report generated.",
      details: {
        startDate: req.query.startDate || "",
        endDate: req.query.endDate || "",
        rowCount: rows.length,
        totalCredit,
        totalDebit
      }
    });

    res.json({
      summary: {
        totalCredit,
        totalDebit,
        balance: totalCredit - totalDebit,
        rowCount: rows.length
      },
      rows
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.getTechReport = async (req, res) => {
  try {
    const db = mongoose.connection.db;
    const clientsCollection = db.collection(collections.clients);
    const systemLogsCollection = db.collection(collections.systemLogs);
    const clients = await clientsCollection.find({}).toArray();
    const auditLogs = await systemLogsCollection.find({}).toArray();

    const start = req.query.startDate
      ? new Date(`${req.query.startDate}T00:00:00`)
      : null;
    const end = req.query.endDate
      ? new Date(`${req.query.endDate}T23:59:59.999`)
      : null;
    const searchText = String(req.query.search || "").trim().toLowerCase();

    const installs = clients
      .map((client) => {
        const installDate = getClientInstallDateValue(client);

        return {
          _id: client._id,
          ClientName: client.ClientName || "-",
          AccountName: client.AccountName || "-",
          AccountNumber: client.AccountNumber || "-",
          AuthenticationMode: client.AuthenticationMode || "-",
          NetPlan: client.NetPlan || client.Profile || "-",
          Address: client.Address || "-",
          ContactNumber: client.ContactNumber || "-",
          Status: client.Status || "-",
          DateInstalled: installDate,
          RawDateInstalled:
            client.DateEntry || client.DateInstalled || client.InstallDate || client.createdAt || ""
        };
      })
      .filter((row) => {
        if (start && row.DateInstalled < start) return false;
        if (end && row.DateInstalled > end) return false;

        if (!searchText) {
          return true;
        }

        return [
          row.ClientName,
          row.AccountName,
          row.AccountNumber,
          row.AuthenticationMode,
          row.NetPlan,
          row.Address,
          row.ContactNumber
        ]
          .join(" ")
          .toLowerCase()
          .includes(searchText);
      })
      .sort((a, b) => b.DateInstalled - a.DateInstalled);

    const repairsDone = auditLogs
      .filter((row) => {
        const moduleValue = String(row.Module || "").trim().toUpperCase();
        const actionValue = String(row.Action || "").trim().toUpperCase();
        const targetTypeValue = String(row.TargetType || "").trim().toUpperCase();
        const summaryValue = String(row.Summary || "").trim().toUpperCase();

        const isRepairRecord =
          moduleValue === "REPAIR" ||
          targetTypeValue === "REPAIR" ||
          actionValue.includes("REPAIR") ||
          summaryValue.includes("REPAIR");

        if (!isRepairRecord) {
          return false;
        }

        const repairDate = getRepairLogDateValue(row);
        if (start && repairDate < start) return false;
        if (end && repairDate > end) return false;

        if (!searchText) {
          return true;
        }

        return [
          row.AccountName,
          row.Action,
          row.Summary,
          row.Actor?.loginAccount,
          row.Actor?.name
        ]
          .join(" ")
          .toLowerCase()
          .includes(searchText);
      })
      .map((row) => ({
        _id: row._id,
        AccountName: row.AccountName || "-",
        Action: row.Action || "-",
        Summary: row.Summary || "-",
        Status: row.Status || "-",
        DoneBy:
          row.Actor?.loginAccount ||
          row.Actor?.username ||
          row.Actor?.name ||
          "-",
        DateDone: getRepairLogDateValue(row),
        Information: row.Values || row.Details || null
      }))
      .sort((a, b) => b.DateDone - a.DateDone);

    await writeAuditLog({
      req,
      module: "REPORT",
      action: "GET_TECH_REPORT",
      targetType: "CLIENT_AND_REPAIR",
      status: "SUCCESS",
      summary: "Tech report generated.",
      details: {
        startDate: req.query.startDate || "",
        endDate: req.query.endDate || "",
        search: req.query.search || "",
        installCount: installs.length,
        repairDoneCount: repairsDone.length
      }
    });

    res.json({
      summary: {
        installCount: installs.length,
        repairDoneCount: repairsDone.length
      },
      installs,
      repairsDone
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.deleteTransactionHistory = async (req, res) => {
  try {
    const { id } = req.params;
    const requestedSource = String(req.query.source || req.body?.source || collections.print)
      .trim()
      .toLowerCase();

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid history record id." });
    }

    const historyCollection = mongoose.connection.db.collection(collections.print);
    const historyRow = await historyCollection.findOne({ _id: new ObjectId(id) });

    if (!historyRow) {
      return res.status(404).json({ error: "History record not found." });
    }

    const result = await historyCollection.deleteOne({ _id: new ObjectId(id) });

    if (!result.deletedCount) {
      return res.status(404).json({ error: "History record not found." });
    }

    const referenceCandidates = [
      String(historyRow.PaymentReceipt || "").trim(),
      String(historyRow.Invoice || "").trim(),
      String(historyRow.TransactionCode || "").trim()
    ].filter(Boolean);
    const accountName = String(historyRow.AccountName || "").trim();

    let deletedEarningsCount = 0;

    if (referenceCandidates.length > 0) {
      const earningsFilter = {
        $or: [
          { Invoice: { $in: referenceCandidates } },
          { PaymentReceipt: { $in: referenceCandidates } },
          { TransactionCode: { $in: referenceCandidates } }
        ]
      };

      if (accountName) {
        earningsFilter.AccountName = accountName;
      }

      const earningsDeleteResult = await mongoose.connection.db
        .collection(collections.earnings)
        .deleteMany(earningsFilter);

      deletedEarningsCount = earningsDeleteResult.deletedCount || 0;
    }

    res.json({
      success: true,
      deletedEarningsCount
    });

    await writeAuditLog({
      req,
      module: "TRANSACTION",
      action: "DELETE",
      targetType: "PRINT",
      targetId: id,
      accountName,
      status: "SUCCESS",
      summary: "Payment history deleted.",
      details: {
        requestedSource,
        deletedEarningsCount,
        references: referenceCandidates
      },
      values: historyRow
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
