const mongoose = require("mongoose");
const { ObjectId } = mongoose.Types;
const collections = require("../config/collections");
const { writeAuditLog } = require("../services/audit-log.service");
const { getMikrotikCheckerSnapshot } = require("../services/mikrotik");
const { getDisconnectAfterDueDays } = require("../services/system-settings.service");

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

const getTransactionDateValue = (row) =>
  new Date(row.TransactionDate || row.PaymentDate || row.createdAt || Date.now());

const getEarningTransactionDateValue = (row) =>
  new Date(row.TransactionDate || row.createdAt || Date.now());

const getExpenseTransactionDateValue = (row) =>
  new Date(row.LogDate || row.createdAt || row.updatedAt || Date.now());

const parseMoneyValue = (value) =>
  Number(String(value || 0).replace(/,/g, "")) || 0;

const normalizePayrollSchedule = (value) => {
  const normalized = String(value || "").trim().toUpperCase();
  return ["15_END", "7_15_22_END"].includes(normalized) ? normalized : "15_END";
};

const getPayrollScheduleLabel = (value) =>
  normalizePayrollSchedule(value) === "7_15_22_END"
    ? "7, 15, 22 and End of Month"
    : "15 and End of Month";

const getPayrollCutoffDays = (value) =>
  normalizePayrollSchedule(value) === "7_15_22_END" ? [7, 15, 22, "END"] : [15, "END"];

const isEndOfMonthDate = (date) => {
  const nextDay = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1);
  return nextDay.getDate() === 1;
};

const getPayrollCutoffKey = (date) =>
  isEndOfMonthDate(date) ? "END" : date.getDate();

const getPreviousPayrollCutoffDate = (date, schedule) => {
  const cutoffs = getPayrollCutoffDays(schedule);
  const candidates = [];

  for (let offset = 0; offset <= 1; offset += 1) {
    const monthDate = new Date(date.getFullYear(), date.getMonth() - offset, 1);
    const year = monthDate.getFullYear();
    const month = monthDate.getMonth();
    const lastDay = new Date(year, month + 1, 0).getDate();

    cutoffs.forEach((cutoff) => {
      const day = cutoff === "END" ? lastDay : cutoff;
      const candidate = new Date(year, month, day, 23, 59, 59, 999);
      if (candidate < date) {
        candidates.push(candidate);
      }
    });
  }

  return candidates.sort((a, b) => b - a)[0] || null;
};

const getPayrollDateRange = (cutoffDate, schedule) => {
  const previousCutoff = getPreviousPayrollCutoffDate(cutoffDate, schedule);
  const start = previousCutoff
    ? new Date(previousCutoff.getFullYear(), previousCutoff.getMonth(), previousCutoff.getDate() + 1, 0, 0, 0, 0)
    : new Date(cutoffDate.getFullYear(), cutoffDate.getMonth(), 1, 0, 0, 0, 0);
  const end = new Date(cutoffDate.getFullYear(), cutoffDate.getMonth(), cutoffDate.getDate(), 23, 59, 59, 999);

  return { start, end, previousCutoff };
};

const getPayrollCutoffDate = (year, month, cutoff) => {
  const lastDay = new Date(year, month + 1, 0).getDate();
  const day = cutoff === "END" ? lastDay : cutoff;
  return new Date(year, month, day, 23, 59, 59, 999);
};

const getPayrollCutoffDatesBetween = (startDate, endDate, schedule) => {
  const cutoffDays = getPayrollCutoffDays(schedule);
  const dates = [];
  const cursor = new Date(startDate.getFullYear(), startDate.getMonth(), 1);
  const endMonth = new Date(endDate.getFullYear(), endDate.getMonth(), 1);

  while (cursor <= endMonth) {
    cutoffDays.forEach((cutoff) => {
      const cutoffDate = getPayrollCutoffDate(
        cursor.getFullYear(),
        cursor.getMonth(),
        cutoff
      );

      if (cutoffDate >= startDate && cutoffDate <= endDate) {
        dates.push(cutoffDate);
      }
    });

    cursor.setMonth(cursor.getMonth() + 1);
  }

  return dates.sort((a, b) => a - b);
};

const isTechnicianCashAdvanceExpense = (expense) => {
  return String(expense?.Type || "").trim().toUpperCase() === "CASH ADVANCE";
};

const buildTechnicianMatchTokens = (technician) =>
  [
    technician?.ID,
    technician?.Username,
    technician?.Name,
    technician?.Contact
  ]
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean);

const isExpenseForTechnician = (expense, technician) => {
  const directTechnicianId = String(expense?.TechnicianId || expense?.technicianId || "").trim();
  const directTechnicianName = String(expense?.TechnicianName || expense?.technicianName || "").trim().toLowerCase();
  const technicianId = String(technician?.ID || "").trim();
  const technicianName = String(technician?.Name || "").trim().toLowerCase();

  if (directTechnicianId && technicianId && directTechnicianId === technicianId) {
    return true;
  }

  if (directTechnicianName && technicianName && directTechnicianName === technicianName) {
    return true;
  }

  const tokens = buildTechnicianMatchTokens(technician);
  if (!tokens.length) {
    return false;
  }

  const haystack = [
    expense?.Name,
    expense?.Type,
    expense?.Docs,
    expense?.Invoice,
    expense?.InCharge,
    expense?.InChargeId,
    expense?.CreatedBy,
    expense?.CreatedById
  ]
    .join(" ")
    .toLowerCase();

  return tokens.some((token) => haystack.includes(token));
};

const sumCashAdvanceAmounts = (expenses = []) =>
  expenses.reduce((sum, expense) => sum + parseMoneyValue(expense.Amount), 0);

const mapCashAdvanceExpense = (expense) => ({
  _id: String(expense._id || ""),
  date: getExpenseTransactionDateValue(expense),
  name: expense.Name || "-",
  invoice: expense.Invoice || "-",
  type: expense.Type || "-",
  amount: parseMoneyValue(expense.Amount),
  docs: expense.Docs || "-"
});

const getTechnicianCashAdvancePayroll = ({
  expenses,
  technician,
  cutoffDate,
  payrollSchedule,
  grossSalary
}) => {
  const selectedRange = getPayrollDateRange(cutoffDate, payrollSchedule);
  const selectedEnd = selectedRange.end;
  const relevantExpenses = expenses
    .filter((expense) => {
      if (!isTechnicianCashAdvanceExpense(expense) || !isExpenseForTechnician(expense, technician)) {
        return false;
      }

      return getExpenseTransactionDateValue(expense) <= selectedEnd;
    })
    .sort((a, b) => getExpenseTransactionDateValue(a) - getExpenseTransactionDateValue(b));

  if (!relevantExpenses.length) {
    return {
      cashAdvances: [],
      periodCashAdvanceTotal: 0,
      cashAdvanceTotal: 0,
      cashAdvanceCarryOver: 0
    };
  }

  const firstExpenseDate = getExpenseTransactionDateValue(relevantExpenses[0]);
  const historyStart = new Date(
    firstExpenseDate.getFullYear(),
    firstExpenseDate.getMonth(),
    1,
    0,
    0,
    0,
    0
  );
  const cutoffDates = getPayrollCutoffDatesBetween(
    historyStart,
    selectedEnd,
    payrollSchedule
  );
  let outstandingAdvance = 0;
  let selectedCashAdvances = [];
  let selectedPeriodCashAdvanceTotal = 0;
  let selectedDeduction = 0;
  let selectedCarryOver = 0;

  cutoffDates.forEach((currentCutoffDate) => {
    const { start, end } = getPayrollDateRange(currentCutoffDate, payrollSchedule);
    const periodExpenses = relevantExpenses.filter((expense) => {
      const expenseDate = getExpenseTransactionDateValue(expense);
      return expenseDate >= start && expenseDate <= end;
    });
    const periodTotal = sumCashAdvanceAmounts(periodExpenses);

    outstandingAdvance += periodTotal;

    const isSelectedCutoff =
      currentCutoffDate.getFullYear() === selectedEnd.getFullYear() &&
      currentCutoffDate.getMonth() === selectedEnd.getMonth() &&
      currentCutoffDate.getDate() === selectedEnd.getDate();
    const deduction = Math.min(grossSalary, outstandingAdvance);

    if (isSelectedCutoff) {
      selectedCashAdvances = periodExpenses.map(mapCashAdvanceExpense);
      selectedPeriodCashAdvanceTotal = periodTotal;
      selectedDeduction = deduction;
      selectedCarryOver = Math.max(0, outstandingAdvance - deduction);
    }

    outstandingAdvance = Math.max(0, outstandingAdvance - deduction);
  });

  return {
    cashAdvances: selectedCashAdvances,
    periodCashAdvanceTotal: selectedPeriodCashAdvanceTotal,
    cashAdvanceTotal: selectedDeduction,
    cashAdvanceCarryOver: selectedCarryOver
  };
};

const normalizeActorToken = (value) =>
  String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

const buildTodayDateOrFilter = (...fieldNames) => {
  const { start, end } = getTodayRange();
  const clauses = fieldNames.map((fieldName) => ({
    [fieldName]: { $gte: start, $lte: end }
  }));

  return clauses.length === 1 ? clauses[0] : { $or: clauses };
};

const getTodayExpenseLogDateValues = () => {
  const today = getManilaTodayStart();
  const year = today.getUTCFullYear();
  const month = today.getUTCMonth() + 1;
  const day = today.getUTCDate();
  const paddedMonth = String(month).padStart(2, "0");
  const paddedDay = String(day).padStart(2, "0");

  return [
    `${year}/${month}/${day}`,
    `${year}/${paddedMonth}/${paddedDay}`,
    `${year}-${paddedMonth}-${paddedDay}`
  ];
};

const buildDashboardExpenseDateFilter = () => {
  const { start, end } = getTodayRange();

  return {
    $or: [
      { LogDate: { $in: getTodayExpenseLogDateValues() } },
      { LogDate: { $gte: start, $lte: end } },
      { createdAt: { $gte: start, $lte: end } }
    ]
  };
};

const buildDashboardExpenseOwnerFilter = (req) => {
  const userType = String(req.user?.type || req.user?.role || "").trim().toUpperCase();
  if (userType === "ADMIN") {
    return null;
  }

  const actorValues = [
    req.user?.id,
    req.user?._id,
    req.user?.username,
    req.user?.Username,
    req.user?.name,
    req.user?.Name
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean);

  if (!actorValues.length) {
    return { _id: null };
  }

  return {
    $or: [
      { InChargeId: { $in: actorValues } },
      { InCharge: { $in: actorValues } },
      { CreatedById: { $in: actorValues } },
      { CreatedBy: { $in: actorValues } }
    ]
  };
};

const getEmptyDashboardPaymentTotals = () => ({
  gcashPayment: 0,
  paymayaPayment: 0,
  bankPayment: 0,
  cashPayment: 0,
  gcashPaidClients: 0,
  paymayaPaidClients: 0,
  bankPaidClients: 0,
  cashPaidClients: 0
});

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

const parseDateOnly = (value) => {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
};

const addDaysUtc = (date, days) => {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
};

const getManilaTodayStart = () => {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  })
    .formatToParts(now)
    .filter((part) => part.type !== "literal")
    .reduce((acc, part) => {
      acc[part.type] = part.value;
      return acc;
    }, {});

  return new Date(
    Date.UTC(Number(parts.year || 0), Number(parts.month || 1) - 1, Number(parts.day || 1))
  );
};

const isClientPlanDisconnected = (client) => {
  const planValue = String(
    client.NetPlan ?? client.Profile ?? client.Plan ?? ""
  ).toUpperCase();
  const statusValue = String(client.Status ?? client.status ?? "").toUpperCase();

  return (
    planValue.includes("DISCONNECTION") ||
    planValue.includes("DISCONNECTED") ||
    statusValue.includes("DISCONNECTION") ||
    statusValue.includes("DISCONNECTED")
  );
};

const isUnpaidClient = (client) => {
  const paymentStatus = String(client?.PaymentStatus || "").trim().toUpperCase();
  const amountDue = Number(client?.AmountDue ?? client?.amountDue ?? 0);

  if (paymentStatus && paymentStatus !== "PAID") {
    return true;
  }

  return Number.isFinite(amountDue) && amountDue > 0;
};

const normalizeBypassAccountKey = (value) =>
  String(value || "")
    .trim()
    .toUpperCase();

const buildBypassLookup = (bypassRows = []) => ({
  accountKeys: new Set(
    (bypassRows || [])
      .map((row) => normalizeBypassAccountKey(row?.AccountNameKey || row?.AccountName))
      .filter(Boolean)
  ),
  accountNumbers: new Set(
    (bypassRows || [])
      .map((row) => normalizeAccountNumber(row?.AccountNumberKey || row?.AccountNumber))
      .filter(Boolean)
  ),
  clientIds: new Set(
    (bypassRows || [])
      .map((row) => String(row?.ClientId || "").trim())
      .filter(Boolean)
  )
});

const isBypassDashboardClient = (client, bypassLookup) => {
  const accountKey = normalizeBypassAccountKey(client?.AccountName);
  const accountNumber = normalizeAccountNumber(client?.AccountNumber);
  const clientId = String(client?._id || "").trim();

  return (
    (accountKey && bypassLookup.accountKeys.has(accountKey)) ||
    (accountNumber && bypassLookup.accountNumbers.has(accountNumber)) ||
    (clientId && bypassLookup.clientIds.has(clientId))
  );
};

const excludeBypassDashboardClients = (clients = [], bypassRows = []) => {
  const bypassLookup = buildBypassLookup(bypassRows);
  return (clients || []).filter((client) => !isBypassDashboardClient(client, bypassLookup));
};

const getDisconnectionTodayRows = (clients = [], graceDays = 15) => {
  const todayStart = getManilaTodayStart();

  return clients
    .filter((client) => {
      const authMode = String(client?.AuthenticationMode || "").trim().toUpperCase();
      if (authMode !== "PPPOE" && authMode !== "IPOE") {
        return false;
      }

      if (isClientPlanDisconnected(client) || !isUnpaidClient(client)) {
        return false;
      }

      const dueDate = parseDateOnly(client?.DueDate);
      if (!dueDate) {
        return false;
      }

      const disconnectDate = addDaysUtc(dueDate, graceDays);
      return disconnectDate.getTime() === todayStart.getTime();
    })
    .map((client) => {
      const dueDate = parseDateOnly(client?.DueDate);
      const disconnectDate = dueDate ? addDaysUtc(dueDate, graceDays) : null;

      return {
        clientId: String(client?._id || "").trim(),
        accountName: client?.AccountName || "-",
        clientName: client?.ClientName || "-",
        authMode: String(client?.AuthenticationMode || "").trim().toUpperCase() || "-",
        mikrotikPlan: "-",
        dueDate: String(client?.DueDate || "").trim() || "-",
        disconnectDate: disconnectDate ? disconnectDate.toISOString().slice(0, 10) : "-",
        amountDue: Number(client?.AmountDue ?? client?.amountDue ?? 0) || 0,
        contactNumber: client?.ContactNumber || client?.Mobile || client?.Phone || "-",
        address: client?.Address || "-"
      };
    })
    .sort((a, b) => a.accountName.localeCompare(b.accountName));
};

const buildClientScheduleRow = (client, todayStart, graceDays = 15) => {
  const dueDate = parseDateOnly(client?.DueDate);
  const disconnectDate = dueDate ? addDaysUtc(dueDate, graceDays) : null;

  const daysPastDue = dueDate
    ? Math.max(
        0,
        Math.floor((todayStart.getTime() - dueDate.getTime()) / (24 * 60 * 60 * 1000))
      )
    : 0;

  return {
    clientId: String(client?._id || "").trim(),
    accountName: client?.AccountName || "-",
    clientName: client?.ClientName || "-",
    authMode: String(client?.AuthenticationMode || "").trim().toUpperCase() || "-",
    dueDate: String(client?.DueDate || "").trim() || "-",
    disconnectDate: disconnectDate ? disconnectDate.toISOString().slice(0, 10) : "-",
    amountDue: Number(client?.AmountDue ?? client?.amountDue ?? 0) || 0,
    contactNumber: client?.ContactNumber || client?.Mobile || client?.Phone || "-",
    address: client?.Address || "-",
    daysPastDue
  };
};

const getDashboardQualifiedClients = (clients = []) =>
  clients.filter((client) => {
    const authMode = String(client?.AuthenticationMode || "").trim().toUpperCase();
    if (authMode !== "PPPOE" && authMode !== "IPOE") {
      return false;
    }

    return !isClientPlanDisconnected(client) && isUnpaidClient(client) && parseDateOnly(client?.DueDate);
  });

const getDueTodayRows = (clients = [], graceDays = 15) => {
  const todayStart = getManilaTodayStart();

  return getDashboardQualifiedClients(clients)
    .filter((client) => {
      const dueDate = parseDateOnly(client?.DueDate);
      return dueDate && dueDate.getTime() === todayStart.getTime();
    })
    .map((client) => buildClientScheduleRow(client, todayStart, graceDays))
    .sort((a, b) => a.accountName.localeCompare(b.accountName));
};

const getPastDueUnpaidRows = (clients = [], graceDays = 15) => {
  const todayStart = getManilaTodayStart();

  return getDashboardQualifiedClients(clients)
    .filter((client) => {
      const dueDate = parseDateOnly(client?.DueDate);
      return dueDate && dueDate.getTime() < todayStart.getTime();
    })
    .map((client) => buildClientScheduleRow(client, todayStart, graceDays))
    .sort((a, b) => b.daysPastDue - a.daysPastDue || a.accountName.localeCompare(b.accountName));
};

const getDashboardClientProjection = () => ({
  AccountNumber: 1,
  AccountName: 1,
  ClientName: 1,
  AuthenticationMode: 1,
  NetPlan: 1,
  Profile: 1,
  Plan: 1,
  Status: 1,
  status: 1,
  PaymentStatus: 1,
  AmountDue: 1,
  amountDue: 1,
  DueDate: 1,
  ContactNumber: 1,
  Mobile: 1,
  Phone: 1,
  Address: 1,
  MacAddress: 1,
  macAddress: 1
});

const summarizeDashboardClients = (clients = [], graceDays = 15) => {
  const todayStart = getManilaTodayStart();
  const summary = {
    activeClients: 0,
    pppoeClients: 0,
    ipoeClients: 0,
    totalClients: clients.length,
    forDisconnectionToday: 0,
    dueToday: 0,
    pastDueUnpaid: 0
  };

  clients.forEach((client) => {
    const authMode = String(client?.AuthenticationMode || "").trim().toUpperCase();
    const disconnected = isDisconnectedClient(client);

    if (!disconnected) {
      summary.activeClients += 1;

      if (authMode === "PPPOE") {
        summary.pppoeClients += 1;
      } else if (authMode === "IPOE") {
        summary.ipoeClients += 1;
      }
    }

    if (authMode !== "PPPOE" && authMode !== "IPOE") {
      return;
    }

    if (isClientPlanDisconnected(client) || !isUnpaidClient(client)) {
      return;
    }

    const dueDate = parseDateOnly(client?.DueDate);
    if (!dueDate) {
      return;
    }

    if (dueDate.getTime() === todayStart.getTime()) {
      summary.dueToday += 1;
    } else if (dueDate.getTime() < todayStart.getTime()) {
      summary.pastDueUnpaid += 1;
    }

    const disconnectDate = addDaysUtc(dueDate, graceDays);
    if (disconnectDate.getTime() === todayStart.getTime()) {
      summary.forDisconnectionToday += 1;
    }
  });

  return summary;
};

const normalizeAccountNumber = (value) =>
  String(value || "").replace(/\s+/g, "").trim();

const normalizeReferenceValue = (value) =>
  String(value || "")
    .replace(/\s+/g, "")
    .trim()
    .toUpperCase();

const normalizeCommentValue = (value) =>
  String(value || "")
    .replace(/\s+/g, " ")
    .trim();

const normalizePaymentMethod = (value) =>
  String(value || "")
    .trim()
    .toUpperCase();

const getPaymentBreakdownLines = (row) => {
  if (Array.isArray(row?.PaymentBreakdown) && row.PaymentBreakdown.length) {
    return row.PaymentBreakdown
      .map((line) => {
        const method = normalizePaymentMethod(line?.Method || line?.PaymentMethod);
        const reference =
          method === "CASH"
            ? ""
            : normalizeReferenceValue(
                line?.Reference || row?.MOPRef || row?.ReferenceNumber || row?.TransactionCode || ""
              );

        return {
          Method: method,
          Amount: Number(line?.Amount || 0),
          Reference: reference,
          ReceiptAmount: Number(
            line?.ReceiptAmount || row?.ReceiptAmount || row?.TotalAmount || row?.Cash || line?.Amount || 0
          ),
          TransferDate: normalizeCommentValue(
            line?.TransferDate || line?.DateOfTransfer || line?.GCashTransferDate || row?.TransferDate || row?.GCashTransferDate
          ),
          ReceiverLast4: normalizeCommentValue(
            line?.ReceiverLast4 || line?.GCashReceiverLast4 || row?.ReceiverLast4 || row?.GCashReceiverLast4
          )
        };
      })
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
      ReceiptAmount: Number(row?.ReceiptAmount || row?.TotalAmount || row?.Cash || 0),
      TransferDate:
          paymentMethod === "CASH"
            ? ""
            : normalizeCommentValue(row?.TransferDate || row?.GCashTransferDate),
        ReceiverLast4:
          paymentMethod === "CASH"
            ? ""
            : normalizeCommentValue(row?.ReceiverLast4 || row?.GCashReceiverLast4)
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

  const nonCashTransferDates = [...new Set(
    paymentBreakdown
      .filter((line) => line.Method !== "CASH" && line.TransferDate)
      .map((line) => normalizeCommentValue(line.TransferDate))
      .filter(Boolean)
  )];
  const nonCashReceiverLast4 = [...new Set(
    paymentBreakdown
      .filter((line) => line.Method !== "CASH" && line.ReceiverLast4)
      .map((line) => normalizeCommentValue(line.ReceiverLast4))
      .filter(Boolean)
  )];

  return {
    PaymentBreakdown: paymentBreakdown,
    PaymentMethod:
      uniqueMethods.length === 1
        ? uniqueMethods[0]
        : paymentBreakdown.length > 1
          ? uniqueMethods.join("/")
          : normalizePaymentMethod(row?.PaymentMethod || row?.MOP) || "CASH",
    ReferenceNumber:
      uniqueNonCashReferences.length === 1
        ? uniqueNonCashReferences[0]
        : "",
    MOPRef:
      uniqueNonCashReferences.length === 1
        ? uniqueNonCashReferences[0]
        : "",
    TransferDate:
      nonCashTransferDates.length === 1
        ? nonCashTransferDates[0]
        : normalizeCommentValue(row?.TransferDate || row?.GCashTransferDate),
    GCashTransferDate:
      nonCashTransferDates.length === 1
        ? nonCashTransferDates[0]
        : normalizeCommentValue(row?.GCashTransferDate || row?.TransferDate),
    ReceiverLast4:
      nonCashReceiverLast4.length === 1
        ? nonCashReceiverLast4[0]
        : normalizeCommentValue(row?.ReceiverLast4 || row?.GCashReceiverLast4)
  };
};

const getDashboardActorFilter = (req) => {
  const actorId = String(req.user?.id || req.user?._id || "").trim();
  const actorName = String(req.user?.name || "").trim().toLowerCase();
  const actorUsername = String(req.user?.username || "").trim().toLowerCase();
  const actorTokens = [
    actorId,
    actorName,
    actorUsername,
    normalizeActorToken(actorId),
    normalizeActorToken(actorName),
    normalizeActorToken(actorUsername)
  ].filter(Boolean);
  const actorType = String(req.user?.type || req.user?.role || "").trim().toUpperCase();

  return (row) => {
    const transactionDate = getEarningTransactionDateValue(row);
    const { start, end } = getTodayRange();

    if (!(transactionDate >= start && transactionDate <= end)) {
      return false;
    }

    if (actorType === "ADMIN") {
      return true;
    }

    const rowOwnerIds = [
      row.DeclaredById,
      row.CreatedById,
      row.DoneById,
      row.ReceivedById,
      row.CollectedById,
      row.UserId,
      row.CashierId
    ]
      .map((value) => String(value || "").trim())
      .filter(Boolean);

    const rowOwners = [
      row.DeclaredBy,
      row.CreatedBy,
      row.DoneBy,
      row.ReceivedBy,
      row.CollectedBy,
      row.Username,
      row.UserName,
      row.Cashier,
      row.CashierName
    ]
      .map((value) => String(value || "").trim().toLowerCase())
      .filter(Boolean);

    const rowOwnerTokens = [
      ...rowOwnerIds,
      ...rowOwners,
      ...rowOwnerIds.map((value) => normalizeActorToken(value)),
      ...rowOwners.map((value) => normalizeActorToken(value))
    ].filter(Boolean);

    return rowOwnerTokens.some((value) => actorTokens.includes(value));
  };
};

const getRequestActor = (req) => {
  const actorId = String(req.user?.id || req.user?._id || req.user?.ID || "").trim();
  const actorName = String(
    req.user?.name || req.user?.Name || req.user?.username || req.user?.Username || ""
  ).trim();

  return {
    id: actorId,
    name: actorName,
    display: actorName || actorId
  };
};

const getDashboardTodayEarnings = (earningsRows = [], req) => {
  const actorFilter = getDashboardActorFilter(req);
  return earningsRows.filter(actorFilter);
};

const getDashboardReceiptKeys = (row = {}) =>
  [
    row._id,
    row.PrintId,
    row.Invoice,
    row.PaymentReceipt,
    row.TransactionCode,
    row.MOPRef,
    row.ReferenceNumber
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean);

const buildDashboardReceiptLookup = (printRows = []) => {
  const lookup = new Map();

  printRows.forEach((row) => {
    getDashboardReceiptKeys(row).forEach((key) => {
      if (!lookup.has(key)) {
        lookup.set(key, row);
      }
    });
  });

  return lookup;
};

const enrichDashboardEarningsWithReceiptOwner = (earningsRows = [], printRows = []) => {
  const receiptLookup = buildDashboardReceiptLookup(printRows);

  return earningsRows.map((row) => {
    const matchedReceipt = getDashboardReceiptKeys(row)
      .map((key) => receiptLookup.get(key))
      .find(Boolean);

    if (!matchedReceipt) {
      return row;
    }

    return {
      ...row,
      AccountNumber: row.AccountNumber || matchedReceipt.AccountNumber,
      ClientName: row.ClientName || matchedReceipt.ClientName,
      DeclaredBy: row.DeclaredBy || matchedReceipt.CreatedBy,
      DeclaredById: row.DeclaredById || matchedReceipt.CreatedById,
      CreatedBy: row.CreatedBy || matchedReceipt.CreatedBy,
      CreatedById: row.CreatedById || matchedReceipt.CreatedById,
      Cashier: row.Cashier || matchedReceipt.CreatedBy,
      CashierId: row.CashierId || matchedReceipt.CreatedById
    };
  });
};

const accumulateDashboardPaymentTotals = (rows = []) => {
  const paymentTotals = getEmptyDashboardPaymentTotals();
  const paidClientSets = {
    GCASH: new Set(),
    PAYMAYA: new Set(),
    BANK: new Set(),
    CASH: new Set()
  };

  rows.forEach((row) => {
    const accountKey = normalizeAccountNumber(
      row.AccountNumber || row.AccountName || row.ClientId || row._id
    );

    getPaymentBreakdownLines(row).forEach((line) => {
      const amount = Number(line.Amount || 0);
      if (!Number.isFinite(amount) || amount <= 0) {
        return;
      }

      if (line.Method === "GCASH") {
        paymentTotals.gcashPayment += amount;
        if (accountKey) paidClientSets.GCASH.add(accountKey);
      } else if (line.Method === "PAYMAYA") {
        paymentTotals.paymayaPayment += amount;
        if (accountKey) paidClientSets.PAYMAYA.add(accountKey);
      } else if (line.Method === "BANK") {
        paymentTotals.bankPayment += amount;
        if (accountKey) paidClientSets.BANK.add(accountKey);
      } else if (line.Method === "CASH") {
        paymentTotals.cashPayment += amount;
        if (accountKey) paidClientSets.CASH.add(accountKey);
      }
    });
  });

  paymentTotals.gcashPaidClients = paidClientSets.GCASH.size;
  paymentTotals.paymayaPaidClients = paidClientSets.PAYMAYA.size;
  paymentTotals.bankPaidClients = paidClientSets.BANK.size;
  paymentTotals.cashPaidClients = paidClientSets.CASH.size;

  return paymentTotals;
};

const getDashboardPaymentTotalsFromEarnings = async (db) => {
  const rows = await db
    .collection(collections.earnings)
    .aggregate([
      { $match: buildTodayDateOrFilter("TransactionDate", "createdAt") },
      {
        $project: {
          method: { $toUpper: { $ifNull: ["$MOP", "$PaymentMethod"] } },
          amount: { $toDouble: { $ifNull: ["$Cash", { $ifNull: ["$TotalAmount", 0] }] } },
          accountKey: {
            $ifNull: [
              "$AccountNumber",
              { $ifNull: ["$AccountName", { $ifNull: ["$ClientName", { $toString: "$_id" }] }] }
            ]
          }
        }
      },
      { $match: { method: { $in: ["GCASH", "PAYMAYA", "BANK", "CASH"] }, amount: { $gt: 0 } } },
      {
        $group: {
          _id: "$method",
          total: { $sum: "$amount" },
          clients: { $addToSet: "$accountKey" }
        }
      }
    ])
    .toArray();
  const totals = getEmptyDashboardPaymentTotals();

  rows.forEach((row) => {
    const method = String(row?._id || "").trim().toUpperCase();
    const amount = Number(row?.total || 0);
    const count = Array.isArray(row?.clients) ? row.clients.length : 0;

    if (method === "GCASH") {
      totals.gcashPayment = amount;
      totals.gcashPaidClients = count;
    } else if (method === "PAYMAYA") {
      totals.paymayaPayment = amount;
      totals.paymayaPaidClients = count;
    } else if (method === "BANK") {
      totals.bankPayment = amount;
      totals.bankPaidClients = count;
    } else if (method === "CASH") {
      totals.cashPayment = amount;
      totals.cashPaidClients = count;
    }
  });

  return totals;
};

const buildDashboardCollectionRows = (rows = [], method) => {
  const normalizedMethod = normalizePaymentMethod(method);

  return rows
    .map((row) => {
      const matchingLines = getPaymentBreakdownLines(row).filter(
        (line) => line.Method === normalizedMethod
      );

      if (!matchingLines.length) {
        return null;
      }

      return {
        rowId: String(row._id || row.Invoice || row.AccountNumber || Math.random()),
        transactionDate: getEarningTransactionDateValue(row),
        transferDate:
          matchingLines
            .map((line) => normalizeCommentValue(line.TransferDate))
            .filter(Boolean)
            .join(", ") ||
          normalizeCommentValue(row.TransferDate || row.GCashTransferDate) ||
            "",
          receiverLast4:
            matchingLines
              .map((line) => normalizeCommentValue(line.ReceiverLast4))
              .filter(Boolean)
              .join(", ") ||
            normalizeCommentValue(row.ReceiverLast4 || row.GCashReceiverLast4) ||
            "",
          accountName: row.AccountName || "-",
        clientName: row.ClientName || row.Name || row.Item || "-",
        method: normalizedMethod,
        reference: matchingLines.map((line) => line.Reference).filter(Boolean).join(", ") || "-",
        receiptNumber: row.PaymentReceipt || row.Invoice || row.TransactionCode || "-",
        amount: matchingLines.reduce((sum, line) => sum + Number(line.Amount || 0), 0),
        createdBy: row.DeclaredBy || row.CreatedBy || row.Cashier || row.Username || "-"
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.transactionDate - a.transactionDate);
};

const formatPrDate = (date) => {
  const targetDate = new Date(date || Date.now());
  const year = String(targetDate.getFullYear()).slice(-2);
  const month = String(targetDate.getMonth() + 1).padStart(2, "0");
  const day = String(targetDate.getDate()).padStart(2, "0");
  return `${year}${month}${day}`;
};

const generateRandomPrNumber = (datePart) => {
  const randomFourDigits = String(Math.floor(Math.random() * 10000)).padStart(4, "0");
  return `PR-${datePart}-${randomFourDigits}`;
};

const receiptNumberExistsInRows = (rows, receiptNumber) => {
  const normalizedReceiptNumber = String(receiptNumber || "").trim().toUpperCase();

  if (!normalizedReceiptNumber) {
    return false;
  }

  return rows.some((row) => {
    const candidates = [
      String(row.Invoice || "").trim().toUpperCase(),
      String(row.PaymentReceipt || "").trim().toUpperCase(),
      String(row.TransactionCode || "").trim().toUpperCase()
    ];

    return candidates.includes(normalizedReceiptNumber);
  });
};

const getNextAvailablePrNumberFromRows = (rows, datePart) => {
  let guard = 0;
  let nextReceiptNumber = generateRandomPrNumber(datePart);

  while (receiptNumberExistsInRows(rows, nextReceiptNumber) && guard < 10000) {
    nextReceiptNumber = generateRandomPrNumber(datePart);
    guard += 1;
  }

  return nextReceiptNumber;
};

const documentNumberExistsInRows = (rows, values = []) => {
  const normalizedValues = values
    .map((value) => String(value || "").trim().toUpperCase())
    .filter(Boolean);

  if (!normalizedValues.length) {
    return false;
  }

  return rows.some((row) => {
    const candidates = [
      String(row.Invoice || "").trim().toUpperCase(),
      String(row.PaymentReceipt || "").trim().toUpperCase(),
      String(row.TransactionCode || "").trim().toUpperCase()
    ].filter(Boolean);

    return normalizedValues.some((value) => candidates.includes(value));
  });
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

const getHistoryReferenceCandidates = (row) =>
  [
    String(row?.Invoice || "").trim(),
    String(row?.PaymentReceipt || "").trim(),
    String(row?.TransactionCode || "").trim()
  ]
    .filter(Boolean)
    .map((value) => value.toUpperCase());

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

const buildEarningRowsByPrintId = (rows = []) => {
  const lookup = new Map();

  rows.forEach((row) => {
    const key = String(row?.PrintId || "").trim();
    if (!key) {
      return;
    }

    const existing = lookup.get(key) || [];
    existing.push(row);
    lookup.set(key, existing);
  });

  return lookup;
};

const enrichPrintHistoryRowWithEarning = (row, earningLookup) => {
  const matchedEarning = getHistoryReferenceCandidates(row)
    .map((key) => earningLookup.get(key))
    .find(Boolean);

  if (!matchedEarning) {
    return row;
  }

  return {
    ...row,
    Verified: row?.Verified === true,
    VerifiedAt: row?.VerifiedAt || "",
    VerifiedBy: row?.VerifiedBy || "",
    VerifiedById: row?.VerifiedById || "",
    PaymentMethod: row?.PaymentMethod || matchedEarning?.MOP || matchedEarning?.PaymentMethod || "",
    MOP: row?.MOP || matchedEarning?.MOP || matchedEarning?.PaymentMethod || "",
    MOPRef:
      row?.MOPRef ||
      matchedEarning?.MOPRef ||
      matchedEarning?.ReferenceNumber ||
      matchedEarning?.TransactionCode ||
      "",
    ReferenceNumber:
      row?.ReferenceNumber ||
      matchedEarning?.MOPRef ||
      matchedEarning?.ReferenceNumber ||
      matchedEarning?.TransactionCode ||
      ""
  };
};

exports.getDashboardSummary = async (req, res) => {
  try {
    const db = mongoose.connection.db;
    const userType = String(req.user?.type || req.user?.role || "").trim().toUpperCase();
    const clients = await db
      .collection(collections.clients)
      .find({}, { projection: getDashboardClientProjection() })
      .toArray();
    const graceDays = await getDisconnectAfterDueDays();
    const clientSummary = summarizeDashboardClients(clients, graceDays);
    const paymentTotals =
      userType === "ADMIN"
        ? await getDashboardPaymentTotalsFromEarnings(db)
        : getEmptyDashboardPaymentTotals();

    res.json({
      ...clientSummary,
      ...paymentTotals
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.getDashboardCollectionList = async (req, res) => {
  try {
    const method = normalizePaymentMethod(req.params.method);
    if (!["GCASH", "PAYMAYA", "BANK", "CASH"].includes(method)) {
      return res.status(400).json({ error: "Invalid collection method." });
    }

    const db = mongoose.connection.db;
    const todayPaymentFilter = buildTodayDateOrFilter("TransactionDate", "createdAt", "PaymentDate");
    const [earningsRows, printRows] = await Promise.all([
      db.collection(collections.earnings).find(todayPaymentFilter).toArray(),
      db.collection(collections.print).find(todayPaymentFilter).toArray()
    ]);

    const dashboardRows = getDashboardTodayEarnings(
      enrichDashboardEarningsWithReceiptOwner(earningsRows, printRows),
      req
    );
    const rows = buildDashboardCollectionRows(dashboardRows, method);

    res.json({
      total: rows.length,
      rows
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.getDashboardExpensesToday = async (req, res) => {
  try {
    const db = mongoose.connection.db;
    const filterParts = [buildDashboardExpenseDateFilter()];
    const ownerFilter = buildDashboardExpenseOwnerFilter(req);

    if (ownerFilter) {
      filterParts.push(ownerFilter);
    }

    const rows = await db
      .collection(collections.expense)
      .find(filterParts.length === 1 ? filterParts[0] : { $and: filterParts })
      .sort({ createdAt: -1, LogDate: -1 })
      .toArray();

    const mappedRows = rows.map((row) => ({
      rowId: String(row._id || row.Invoice || Math.random()),
      transactionDate: getExpenseTransactionDateValue(row),
      logDate: row.LogDate || "",
      name: row.Name || "-",
      type: row.Type || "Expense",
      invoice: row.Invoice || "-",
      amount: parseMoneyValue(row.Amount),
      docs: row.Docs || "-",
      inCharge: row.InCharge || row.CreatedBy || "-"
    }));

    res.json({
      total: mappedRows.length,
      amount: mappedRows.reduce((sum, row) => sum + Number(row.amount || 0), 0),
      rows: mappedRows
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.getDashboardDisconnectionToday = async (_req, res) => {
  try {
    const [clients, bypassRows] = await Promise.all([
      mongoose.connection.db
        .collection(collections.clients)
        .find({})
        .toArray(),
      mongoose.connection.db
        .collection(collections.clientBypass)
        .find({})
        .toArray()
    ]);
    const dashboardClients = excludeBypassDashboardClients(clients, bypassRows);

    const graceDays = await getDisconnectAfterDueDays();
    const rows = getDisconnectionTodayRows(dashboardClients, graceDays);
    const clientMap = new Map(
      dashboardClients.map((client) => [String(client?._id || "").trim(), client])
    );
    let snapshot = { pppSecrets: [], dhcpLeases: [] };

    try {
      snapshot = (await getMikrotikCheckerSnapshot()) || snapshot;
    } catch (_error) {
      snapshot = { pppSecrets: [], dhcpLeases: [] };
    }

    const pppSecretPlanByAccount = new Map(
      (Array.isArray(snapshot.pppSecrets) ? snapshot.pppSecrets : []).map((secret) => [
        String(secret?.name || "").trim().toUpperCase(),
        String(secret?.profile || "").trim() || "Not Found"
      ])
    );

    const dhcpPlanByKey = new Map();
    (Array.isArray(snapshot.dhcpLeases) ? snapshot.dhcpLeases : []).forEach((lease) => {
      const comment = String(lease?.comment || "");
      const accountMatch = comment.match(/NAME=([^;]+)/i);
      const planMatch = comment.match(/PLAN=([^;]+)/i);
      const accountKey = String(accountMatch?.[1] || "").trim().toUpperCase();
      const macKey = String(lease?.["mac-address"] || lease?.macAddress || "")
        .trim()
        .toUpperCase();
      const planValue = String(planMatch?.[1] || "").trim() || "Not Found";

      if (accountKey) {
        dhcpPlanByKey.set(`ACCOUNT:${accountKey}`, planValue);
      }

      if (macKey) {
        dhcpPlanByKey.set(`MAC:${macKey}`, planValue);
      }
    });

    const enrichedRows = rows.map((row) => {
      const client = clientMap.get(String(row.clientId || "").trim());
      const authMode = String(row.authMode || "").trim().toUpperCase();

      if (!client) {
        return {
          ...row,
          mikrotikPlan: "Not Found"
        };
      }

      if (authMode === "PPPOE") {
        const accountKey = String(client.AccountName || "").trim().toUpperCase();
        return {
          ...row,
          mikrotikPlan: pppSecretPlanByAccount.get(accountKey) || "Not Found"
        };
      }

      if (authMode === "IPOE") {
        const accountKey = String(client.AccountName || "").trim().toUpperCase();
        const macKey = String(client.MacAddress || client.macAddress || "")
          .trim()
          .toUpperCase();
        return {
          ...row,
          mikrotikPlan:
            dhcpPlanByKey.get(`ACCOUNT:${accountKey}`) ||
            dhcpPlanByKey.get(`MAC:${macKey}`) ||
            "Not Found"
        };
      }

      return {
        ...row,
        mikrotikPlan: "Not Found"
      };
    });

    res.json({
      total: enrichedRows.length,
      rows: enrichedRows
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.getDashboardDueToday = async (_req, res) => {
  try {
    const [clients, bypassRows] = await Promise.all([
      mongoose.connection.db
        .collection(collections.clients)
        .find({})
        .toArray(),
      mongoose.connection.db
        .collection(collections.clientBypass)
        .find({})
        .toArray()
    ]);

    const graceDays = await getDisconnectAfterDueDays();
    const rows = getDueTodayRows(excludeBypassDashboardClients(clients, bypassRows), graceDays);
    res.json({
      total: rows.length,
      rows
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.getDashboardPastDueUnpaid = async (_req, res) => {
  try {
    const [clients, bypassRows] = await Promise.all([
      mongoose.connection.db
        .collection(collections.clients)
        .find({})
        .toArray(),
      mongoose.connection.db
        .collection(collections.clientBypass)
        .find({})
        .toArray()
    ]);

    const graceDays = await getDisconnectAfterDueDays();
    const rows = getPastDueUnpaidRows(excludeBypassDashboardClients(clients, bypassRows), graceDays);
    res.json({
      total: rows.length,
      rows
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.getPullOutReport = async (req, res) => {
  try {
    const requestedDays = Number(req.query.days || 30);
    const overdueDays =
      Number.isFinite(requestedDays) && requestedDays >= 0
        ? Math.floor(requestedDays)
        : 30;
    const todayStart = getManilaTodayStart();

    const [clients, bypassRows] = await Promise.all([
      mongoose.connection.db
        .collection(collections.clients)
        .find({}, { projection: getDashboardClientProjection() })
        .toArray(),
      mongoose.connection.db
        .collection(collections.clientBypass)
        .find({})
        .toArray()
    ]);

    const rows = getDashboardQualifiedClients(
      excludeBypassDashboardClients(clients, bypassRows)
    )
      .map((client) => {
        const dueDate = parseDateOnly(client?.DueDate);
        const daysPastDue = dueDate
          ? Math.max(
              0,
              Math.floor((todayStart.getTime() - dueDate.getTime()) / (24 * 60 * 60 * 1000))
            )
          : 0;
        const eligibleDate = dueDate ? addDaysUtc(dueDate, overdueDays) : null;

        return {
          clientId: String(client?._id || "").trim(),
          accountNumber: client?.AccountNumber || "-",
          accountName: client?.AccountName || "-",
          clientName: client?.ClientName || "-",
          authMode: String(client?.AuthenticationMode || "").trim().toUpperCase() || "-",
          netPlan: client?.NetPlan || client?.Profile || client?.Plan || "-",
          dueDate: dueDate ? dueDate.toISOString().slice(0, 10) : String(client?.DueDate || "-"),
          eligibleDate: eligibleDate ? eligibleDate.toISOString().slice(0, 10) : "-",
          daysPastDue,
          amountDue: Number(client?.AmountDue ?? client?.amountDue ?? 0) || 0,
          paymentStatus: client?.PaymentStatus || "-",
          contactNumber: client?.ContactNumber || client?.Mobile || client?.Phone || "-",
          address: client?.Address || "-"
        };
      })
      .filter((row) => row.daysPastDue >= overdueDays)
      .sort((a, b) => b.daysPastDue - a.daysPastDue || a.accountName.localeCompare(b.accountName));

    await writeAuditLog({
      req,
      module: "REPORT",
      action: "GET_PULL_OUT_REPORT",
      targetType: "CLIENT",
      status: "SUCCESS",
      summary: "Pull out report generated.",
      details: {
        overdueDays,
        rowCount: rows.length
      }
    });

    res.json({
      summary: {
        overdueDays,
        asOfDate: todayStart.toISOString().slice(0, 10),
        rowCount: rows.length
      },
      rows
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.getTransactions = async (req, res) => {
  try {
    const db = mongoose.connection.db;
    const printCollection = db.collection(collections.print);
    const earningsCollection = db.collection(collections.earnings);
    const requestedAccountNumber = normalizeAccountNumber(req.query.accountNumber);
    const requestedAccountName = String(req.query.accountName || "").trim();
    const requestedClientId = String(req.query.clientId || "").trim();
    let printRows = [];
    let earningRows = [];

    const printQuery = {};

    if (requestedAccountNumber) {
      printQuery.AccountNumber = requestedAccountNumber;
    } else if (requestedClientId) {
      printQuery.ClientId = requestedClientId;
    } else if (requestedAccountName) {
      printQuery.AccountName = requestedAccountName;
    }

    if (String(req.user.type || req.user.role || "").toUpperCase() === "CASHIER" && !requestedAccountNumber) {
      const { start, end } = getTodayRange();
      printQuery.TransactionDate = { $gte: start, $lte: end };
    } else if (req.query.startDate || req.query.endDate) {
      const start = req.query.startDate
        ? new Date(`${req.query.startDate}T00:00:00`)
        : null;
      const end = req.query.endDate
        ? new Date(`${req.query.endDate}T23:59:59.999`)
        : null;

      if (start || end) {
        printQuery.TransactionDate = {};
        if (start) {
          printQuery.TransactionDate.$gte = start;
        }
        if (end) {
          printQuery.TransactionDate.$lte = end;
        }
      }
    }

    try {
      printRows = await printCollection
        .find(printQuery, {
          projection: {
            AccountName: 1,
            AccountNumber: 1,
            Balance: 1,
            ClientId: 1,
            ClientName: 1,
            Cover: 1,
            CreatedBy: 1,
            DueDate: 1,
            Invoice: 1,
            MOP: 1,
            MOPRef: 1,
            NetPlan: 1,
            PaymentDate: 1,
            PaymentMethod: 1,
            PaymentReceipt: 1,
            ReferenceNumber: 1,
            TotalAmount: 1,
            TransactionCode: 1,
            TransactionDate: 1,
            Type: 1,
            Verified: 1,
            VerifiedAt: 1,
            VerifiedBy: 1,
            VerifiedById: 1,
            createdAt: 1
          }
        })
        .sort({ TransactionDate: -1, PaymentDate: -1, createdAt: -1 })
        .toArray();
    } catch (err) {
      console.warn("PRINT COLLECTION QUERY WARNING:", err.message);
      printRows = [];
    }

    const printIds = printRows
      .map((row) => String(row?._id || "").trim())
      .filter((value) => ObjectId.isValid(value));
    const accountNames = [...new Set(printRows.map((row) => String(row.AccountName || "").trim()).filter(Boolean))];
    const historyReferences = [...new Set(printRows.flatMap((row) => getHistoryReferenceCandidates(row)).filter(Boolean))];

    if (printIds.length || accountNames.length || historyReferences.length) {
      const earningClauses = [
        ...(printIds.length
          ? [{ PrintId: { $in: printIds } }]
          : []),
        ...(accountNames.length ? [{ AccountName: { $in: accountNames } }] : []),
        ...(historyReferences.length
          ? [
              { Invoice: { $in: historyReferences } },
              { MOPRef: { $in: historyReferences } },
              { ReferenceNumber: { $in: historyReferences } },
              { TransactionCode: { $in: historyReferences } }
            ]
          : [])
      ];

      const earningQuery = earningClauses.length === 1
        ? earningClauses[0]
        : { $or: earningClauses };

      try {
        earningRows = await earningsCollection
          .find(earningQuery, {
            projection: {
              AccountName: 1,
              Cash: 1,
              Invoice: 1,
              MOP: 1,
              MOPRef: 1,
              PaymentMethod: 1,
              PrintId: 1,
              ReceiptAmount: 1,
              ReferenceNumber: 1,
              ReceiptImage: 1,
              ReceiverLast4: 1,
              TransferDate: 1,
              TransactionDate: 1,
              TransactionCode: 1,
              Verified: 1,
              VerifiedAt: 1,
              VerifiedBy: 1,
              VerifiedById: 1
            }
          })
          .toArray();
      } catch (err) {
        console.warn("EARNINGS COLLECTION QUERY WARNING:", err.message);
        earningRows = [];
      }
    }

    const earningLookup = buildEarningLookupMap(earningRows);
    const earningRowsByPrintId = buildEarningRowsByPrintId(earningRows);

    const printHistoryRows = printRows.map((row) => ({
      ...enrichPrintHistoryRowWithEarning(row, earningLookup),
      EarningRows: earningRowsByPrintId.get(String(row?._id || "").trim()) || [],
      HistorySource: "print"
    }));

    let filteredTransactions = mergeHistoryRows(printHistoryRows).filter((row) => {
      const rowAccountNumber = normalizeAccountNumber(row.AccountNumber);
      return !requestedAccountNumber || rowAccountNumber === requestedAccountNumber;
    });

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
    const { PaymentBreakdown, ...topLevelPaymentFields } = normalizedPaymentFields;
    const actor = getRequestActor(req);
    const payload = {
      ...req.body,
      ...topLevelPaymentFields,
      ClientId: req.body.ClientId || "",
      Type: req.body.Type || "Payment",
      MOP: topLevelPaymentFields.PaymentMethod,
      CreatedBy: actor.display || "",
      CreatedById: actor.id || "",
      Cashier: actor.display || "",
      CashierId: actor.id || "",
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
    const actor = getRequestActor(req);
    const payload = {
      ...req.body,
      DeclaredBy: actor.display || "",
      DeclaredById: actor.id || "",
      CreatedBy: actor.display || "",
      CreatedById: actor.id || "",
      Cashier: actor.display || "",
      CashierId: actor.id || "",
      TransactionDate: req.body.TransactionDate
        ? new Date(req.body.TransactionDate)
        : new Date(),
      createdAt: req.body.createdAt ? new Date(req.body.createdAt) : new Date(),
      updatedAt: new Date()
    };

    const result = await mongoose.connection.db
      .collection(collections.earnings)
      .insertOne(payload);

    if (payload.PrintId && ObjectId.isValid(String(payload.PrintId))) {
      await mongoose.connection.db.collection(collections.print).updateOne(
        { _id: new ObjectId(String(payload.PrintId)) },
        {
          $addToSet: { EarningIds: result.insertedId },
          $inc: { LinkedEarningCount: 1 },
          $set: { updatedAt: new Date() }
        }
      );
    }

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

exports.rollbackPaymentSave = async (req, res) => {
  try {
    const earningIds = Array.isArray(req.body?.earningIds)
      ? req.body.earningIds.filter(Boolean)
      : req.body?.earningId
        ? [req.body.earningId]
        : [];
    const transactionId = req.body?.transactionId;

    const rollbackSummary = {
      earningDeleted: false,
      earningDeletedCount: 0,
      transactionDeleted: false
    };

    if (earningIds.length) {
      const earningObjectIds = earningIds.map(
        (earningId) => new mongoose.Types.ObjectId(String(earningId))
      );
      const earningDeleteResult = await mongoose.connection.db
        .collection(collections.earnings)
        .deleteMany({ _id: { $in: earningObjectIds } });

      rollbackSummary.earningDeleted = earningDeleteResult.deletedCount > 0;
      rollbackSummary.earningDeletedCount = earningDeleteResult.deletedCount || 0;
    }

    if (transactionId) {
      const transactionDeleteResult = await mongoose.connection.db
        .collection(collections.print)
        .deleteOne({ _id: new mongoose.Types.ObjectId(String(transactionId)) });

      rollbackSummary.transactionDeleted = transactionDeleteResult.deletedCount > 0;
    }

    await writeAuditLog({
      req,
      module: "PAYMENT",
      action: "ROLLBACK",
      targetType: "PAYMENT_SAVE",
      targetId: transactionId || earningIds[0] || "",
      accountName: req.body?.AccountName || "",
      status: "SUCCESS",
      summary: "Rolled back partially saved payment records.",
      values: {
        earningIds,
        transactionId: transactionId || "",
        ...rollbackSummary
      }
    });

    res.json({
      success: true,
      ...rollbackSummary
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
    const printCollection = db.collection(collections.print);
    const earningsCollection = db.collection(collections.earnings);
    const datePart = formatPrDate(requestedDate);
    const receiptPrefix = `PR-${datePart}-`;
    const invoicePrefix = `SI-${datePart}-`;

    const [printLatest, earningsLatest] = await Promise.all([
      printCollection
        .find(
          { PaymentReceipt: { $regex: `^${receiptPrefix}` } },
          { projection: { PaymentReceipt: 1 } }
        )
        .sort({ PaymentReceipt: -1 })
        .limit(1)
        .toArray(),
      earningsCollection
        .find(
          { Invoice: { $regex: `^${invoicePrefix}` } },
          { projection: { Invoice: 1 } }
        )
        .sort({ Invoice: -1 })
        .limit(1)
        .toArray(),
    ]);

    const extractSuffix = (value, prefix) => {
      const raw = String(value || "").trim().toUpperCase();
      const normalizedPrefix = String(prefix || "").toUpperCase();

      if (!raw.startsWith(normalizedPrefix)) {
        return 0;
      }

      const suffix = Number.parseInt(raw.slice(normalizedPrefix.length), 10);
      return Number.isFinite(suffix) ? suffix : 0;
    };

    const maxSuffix = Math.max(
      extractSuffix(printLatest[0]?.PaymentReceipt, receiptPrefix),
      extractSuffix(earningsLatest[0]?.Invoice, invoicePrefix)
    );

    let nextSuffix = maxSuffix + 1;
    let nextNumber = null;

    for (let attempt = 0; attempt < 25; attempt += 1) {
      const paddedSuffix = String(nextSuffix).padStart(4, "0");
      const receiptNumber = `PR-${datePart}-${paddedSuffix}`;
      const invoiceNumber = `SI-${datePart}-${paddedSuffix}`;

      const [printMatch, earningMatch] = await Promise.all([
        printCollection.findOne({
          $or: [
            { PaymentReceipt: receiptNumber },
            { Invoice: invoiceNumber },
            { TransactionCode: receiptNumber },
          ],
        }),
        earningsCollection.findOne({ Invoice: invoiceNumber }),
      ]);

      if (!printMatch && !earningMatch) {
        nextNumber = receiptNumber;
        break;
      }

      nextSuffix += 1;
    }

    if (!nextNumber) {
      return res.status(503).json({
        error: "Unable to generate a unique payment reference right now. Please try again.",
      });
    }

    res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");
    res.json({ receiptNumber: nextNumber });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
exports.validatePaymentDocuments = async (req, res) => {
  try {
    const paymentReceipt = String(req.body?.paymentReceipt || "").trim();
    const salesInvoice = String(req.body?.salesInvoice || "").trim();
    const valuesToCheck = [paymentReceipt, salesInvoice].filter(Boolean);

    if (!valuesToCheck.length) {
      return res.status(400).json({ error: "Payment receipt or sales invoice is required." });
    }

    const db = mongoose.connection.db;
    const [printRows, earningRows] = await Promise.all([
      db.collection(collections.print).find({}).toArray(),
      db.collection(collections.earnings).find({}).toArray()
    ]);

    const allRows = [...printRows, ...earningRows];
    const duplicateValues = valuesToCheck.filter((value) =>
      documentNumberExistsInRows(allRows, [value])
    );

    if (duplicateValues.length) {
      return res.status(409).json({
        valid: false,
        error: `Document number already exists: ${duplicateValues.join(", ")}.`,
        duplicates: duplicateValues
      });
    }

    res.json({
      valid: true,
      duplicates: []
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.validatePaymentReferences = async (req, res) => {
  try {
    const requestedEntries = Array.isArray(req.body?.entries) ? req.body.entries : [];
    const normalizedEntries = requestedEntries
      .map((entry) => ({
        method: normalizePaymentMethod(entry?.method),
        amount: Number(entry?.amount || 0),
        reference: normalizeReferenceValue(entry?.reference),
        receiptAmount: Number(entry?.receiptAmount || 0)
      }))
      .filter(
        (entry) =>
          entry.method &&
          entry.method !== "CASH" &&
          entry.reference &&
          Number.isFinite(entry.amount) &&
          entry.amount > 0
      );

    if (!normalizedEntries.length) {
      return res.json({ valid: true, refs: [] });
    }

    const requestedByReference = normalizedEntries.reduce((map, entry) => {
      const existing = map.get(entry.reference) || {
        reference: entry.reference,
        requestedAmount: 0,
        receiptAmount: 0
      };

      existing.requestedAmount += Number(entry.amount || 0);
      existing.receiptAmount = Math.max(existing.receiptAmount, Number(entry.receiptAmount || 0));
      map.set(entry.reference, existing);
      return map;
    }, new Map());

    const references = [...requestedByReference.keys()];
    const db = mongoose.connection.db;
    const earningRows = await db
      .collection(collections.earnings)
      .find({
        $or: [
          { MOPRef: { $in: references } },
          { ReferenceNumber: { $in: references } },
          { "PaymentBreakdown.Reference": { $in: references } }
        ]
      })
      .toArray();

    const usageByReference = new Map();

    references.forEach((reference) => {
      usageByReference.set(reference, {
        usedAmount: 0,
        receiptAmount: 0,
        usedByAccounts: new Set()
      });
    });

    earningRows.forEach((row) => {
      const accountName = String(row?.AccountName || row?.ClientName || row?.Name || "").trim();
      getPaymentBreakdownLines(row).forEach((line) => {
        if (!references.includes(line.Reference)) {
          return;
        }

        const usage = usageByReference.get(line.Reference);
        if (!usage) {
          return;
        }

        usage.usedAmount += Number(line.Amount || 0);
        usage.receiptAmount = Math.max(usage.receiptAmount, Number(line.ReceiptAmount || 0));
        if (accountName) {
          usage.usedByAccounts.add(accountName);
        }
      });
    });

    const refs = references.map((reference) => {
      const requested = requestedByReference.get(reference);
      const usage = usageByReference.get(reference) || {
        usedAmount: 0,
        receiptAmount: 0,
        usedByAccounts: new Set()
      };

      const allowedAmount = Math.max(
        Number(requested?.receiptAmount || 0),
        Number(usage?.receiptAmount || 0)
      );
      const totalAfterSave = Number(usage.usedAmount || 0) + Number(requested?.requestedAmount || 0);
      const exceeds = allowedAmount > 0 && totalAfterSave > allowedAmount + 0.0001;

      return {
        reference,
        requestedAmount: Number(requested?.requestedAmount || 0),
        receiptAmount: allowedAmount,
        alreadyUsedAmount: Number(usage.usedAmount || 0),
        totalAfterSave,
        exceeds,
        usedByAccounts: [...usage.usedByAccounts]
      };
    });

    const exceededRefs = refs.filter((item) => item.exceeds);

    if (exceededRefs.length) {
      return res.status(409).json({
        valid: false,
        error: `Reference amount exceeded for: ${exceededRefs
          .map(
            (item) =>
              `${item.reference} (used ${item.alreadyUsedAmount.toFixed(2)} + current ${item.requestedAmount.toFixed(
                2
              )} > receipt ${item.receiptAmount.toFixed(2)})`
          )
          .join(", ")}.`,
        refs
      });
    }

    return res.json({
      valid: true,
      refs
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

exports.getEarnings = async (req, res) => {
  try {
    const db = mongoose.connection.db;
    const earningsCollection = db.collection(collections.earnings);
    const printCollection = db.collection(collections.print);
    const userType = String(req.user.type || req.user.role || "").toUpperCase();
    let rangeStart = null;
    let rangeEnd = null;

    if (userType === "CASHIER") {
      const range = getTodayRange();
      rangeStart = range.start;
      rangeEnd = range.end;
    } else if (req.query.startDate || req.query.endDate) {
      rangeStart = req.query.startDate
        ? new Date(`${req.query.startDate}T00:00:00`)
        : null;
      rangeEnd = req.query.endDate
        ? new Date(`${req.query.endDate}T23:59:59.999`)
        : null;
    }

    const buildRangeClause = (fieldName) => {
      const clause = {};
      if (rangeStart) {
        clause.$gte = rangeStart;
      }
      if (rangeEnd) {
        clause.$lte = rangeEnd;
      }
      return Object.keys(clause).length ? { [fieldName]: clause } : null;
    };

    const earningsFilter = {};
    const earningsRangeClauses = [
      buildRangeClause("TransactionDate"),
      buildRangeClause("createdAt")
    ].filter(Boolean);

    if (earningsRangeClauses.length === 1) {
      Object.assign(earningsFilter, earningsRangeClauses[0]);
    } else if (earningsRangeClauses.length > 1) {
      earningsFilter.$or = earningsRangeClauses;
    }

    const earningsProjection = {
      TransactionDate: 1,
      createdAt: 1,
      Invoice: 1,
      Item: 1,
      ClientName: 1,
      AccountName: 1,
      DeclaredBy: 1,
      DeclaredById: 1,
      CreatedBy: 1,
      CreatedById: 1,
      DoneBy: 1,
      DoneById: 1,
      ReceivedBy: 1,
      ReceivedById: 1,
      CollectedBy: 1,
      CollectedById: 1,
      Username: 1,
      UserName: 1,
      UserId: 1,
      Cashier: 1,
      CashierName: 1,
      CashierId: 1,
      Cash: 1,
      TotalAmount: 1,
      MOP: 1,
      Type: 1,
      MOPRef: 1,
      ReferenceNumber: 1,
      PaymentReceipt: 1,
      TransactionCode: 1,
      TransferDate: 1,
      GCashTransferDate: 1,
      ReceiverLast4: 1,
      GCashReceiverLast4: 1,
      Verified: 1,
      VerifiedAt: 1,
      VerifiedBy: 1,
      VerifiedById: 1,
      VerificationMethod: 1,
      VerifiedReference: 1,
      VerificationComment: 1
    };

    const earnings = await earningsCollection
      .find(earningsFilter, { projection: earningsProjection })
      .toArray();

    const verificationLookup = new Map();

    const getVerificationCandidates = (row = {}) =>
      [
        row?.Invoice,
        row?.PaymentReceipt,
        row?.TransactionCode,
        row?.MOPRef,
        row?.ReferenceNumber,
        row?.VerifiedReference
      ]
          .map((value) => normalizeReferenceValue(value))
          .filter(Boolean);

    const getVerificationQueryCandidates = (row = {}) =>
      [
        row?.Invoice,
        row?.PaymentReceipt,
        row?.TransactionCode,
        row?.MOPRef,
        row?.ReferenceNumber,
        row?.VerifiedReference
      ]
        .flatMap((value) => {
          const raw = String(value || "").trim();
          const normalized = normalizeReferenceValue(value);
          return [raw, normalized];
        })
        .filter(Boolean);

    const verificationKeys = Array.from(
      new Set(
        earnings.flatMap((row) => getVerificationQueryCandidates(row))
      )
    );

    let printRows = [];

    if (verificationKeys.length > 0) {
      const printProjection = {
        PaymentReceipt: 1,
        Invoice: 1,
        TransactionCode: 1,
        MOPRef: 1,
        ReferenceNumber: 1,
        VerifiedReference: 1,
        Verified: 1,
        VerifiedAt: 1,
        VerifiedBy: 1,
        VerifiedById: 1,
        VerificationMethod: 1,
        VerificationComment: 1
      };

      const printReferenceFilter = {
        $or: [
          { PaymentReceipt: { $in: verificationKeys } },
          { Invoice: { $in: verificationKeys } },
          { TransactionCode: { $in: verificationKeys } },
          { MOPRef: { $in: verificationKeys } },
          { ReferenceNumber: { $in: verificationKeys } },
          { VerifiedReference: { $in: verificationKeys } }
        ]
      };

      printRows = await printCollection
        .find(printReferenceFilter, { projection: printProjection })
        .toArray();
    }

    printRows.forEach((row) => {
      getVerificationCandidates(row).forEach((key) => {
        if (key && !verificationLookup.has(key)) {
          verificationLookup.set(key, row);
        }
      });
    });

    const enrichEarningVerification = (row) => {
      const matchedPrint = getVerificationCandidates(row)
        .map((key) => verificationLookup.get(key))
        .find(Boolean);
      const earningHasVerification =
        row?.Verified === true ||
        Boolean(row?.VerifiedAt) ||
        Boolean(row?.VerifiedBy) ||
        Boolean(row?.VerifiedById) ||
        Boolean(row?.VerificationMethod) ||
        Boolean(row?.VerifiedReference) ||
        Boolean(row?.VerificationComment);

      if (earningHasVerification || !matchedPrint) {
        return {
          ...row,
          Verified: row?.Verified === true,
          VerifiedAt: row?.VerifiedAt || "",
          VerifiedBy: row?.VerifiedBy || "",
          VerifiedById: row?.VerifiedById || "",
          VerificationMethod: row?.VerificationMethod || "",
          VerifiedReference: row?.VerifiedReference || "",
          VerificationComment: row?.VerificationComment || ""
        };
      }

      return {
        ...row,
        Verified: matchedPrint?.Verified === true,
        VerifiedAt: matchedPrint?.VerifiedAt || row?.VerifiedAt || "",
        VerifiedBy: matchedPrint?.VerifiedBy || row?.VerifiedBy || "",
        VerifiedById: matchedPrint?.VerifiedById || row?.VerifiedById || "",
        VerificationMethod: matchedPrint?.VerificationMethod || row?.VerificationMethod || "",
        VerifiedReference: matchedPrint?.VerifiedReference || row?.VerifiedReference || "",
        VerificationComment: matchedPrint?.VerificationComment || row?.VerificationComment || ""
      };
    };

    let filteredEarnings = earnings.map(enrichEarningVerification);
    if (userType === "CASHIER") {
      filteredEarnings = filteredEarnings.filter(getDashboardActorFilter(req));
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

exports.getTechnicianPayrollReport = async (req, res) => {
  try {
    const cutoffDate = req.query.cutoffDate
      ? new Date(`${req.query.cutoffDate}T00:00:00`)
      : new Date();

    if (Number.isNaN(cutoffDate.getTime())) {
      return res.status(400).json({ error: "Invalid cutoff date." });
    }

    const cutoffKey = getPayrollCutoffKey(cutoffDate);
    const db = mongoose.connection.db;
    const credentialsCollection = db.collection(collections.credentials);
    const expenseCollection = db.collection(collections.expense);
    const technicians = (await credentialsCollection.find({}).toArray()).filter((user) =>
      ["TECHNICIAN", "EMPLOYEE"].includes(String(user.Type || "").trim().toUpperCase())
    );
    const expenses = await expenseCollection.find({}).toArray();

    const rows = technicians
      .map((technician) => {
        const payrollSchedule = normalizePayrollSchedule(technician.PayrollSchedule);
        const cutoffDays = getPayrollCutoffDays(payrollSchedule);
        const isIncluded = cutoffDays.includes(cutoffKey);
        const { start, end, previousCutoff } = getPayrollDateRange(cutoffDate, payrollSchedule);
        const monthlySalary = parseMoneyValue(technician.Salary);
        const grossSalary = isIncluded ? monthlySalary / cutoffDays.length : 0;
        const cashAdvancePayroll = isIncluded
          ? getTechnicianCashAdvancePayroll({
              expenses,
              technician,
              cutoffDate,
              payrollSchedule,
              grossSalary
            })
          : {
              cashAdvances: [],
              periodCashAdvanceTotal: 0,
              cashAdvanceTotal: 0,
              cashAdvanceCarryOver: 0
            };

        return {
          technicianId: String(technician.ID || ""),
          name: technician.Name || "-",
          username: technician.Username || "-",
          contact: technician.Contact || "-",
          monthlySalary,
          payrollSchedule,
          payrollScheduleLabel: getPayrollScheduleLabel(payrollSchedule),
          cutoffCount: cutoffDays.length,
          cutoffDate,
          cutoffStartDate: start,
          previousCutoffDate: previousCutoff,
          isIncluded,
          grossSalary,
          periodCashAdvanceTotal: cashAdvancePayroll.periodCashAdvanceTotal,
          cashAdvanceTotal: cashAdvancePayroll.cashAdvanceTotal,
          cashAdvanceCarryOver: cashAdvancePayroll.cashAdvanceCarryOver,
          netSalary: Math.max(0, grossSalary - cashAdvancePayroll.cashAdvanceTotal),
          cashAdvances: cashAdvancePayroll.cashAdvances
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));

    const includedRows = rows.filter((row) => row.isIncluded);
    const summary = {
      cutoffDate,
      cutoffKey,
      technicianCount: includedRows.length,
      grossSalaryTotal: includedRows.reduce((sum, row) => sum + Number(row.grossSalary || 0), 0),
      cashAdvanceTotal: includedRows.reduce((sum, row) => sum + Number(row.cashAdvanceTotal || 0), 0),
      cashAdvanceCarryOverTotal: includedRows.reduce(
        (sum, row) => sum + Number(row.cashAdvanceCarryOver || 0),
        0
      ),
      netSalaryTotal: includedRows.reduce((sum, row) => sum + Number(row.netSalary || 0), 0)
    };

    await writeAuditLog({
      req,
      module: "REPORT",
      action: "GET_TECHNICIAN_PAYROLL",
      targetType: "PAYROLL",
      status: "SUCCESS",
      summary: "Technician payroll report generated.",
      details: {
        cutoffDate: req.query.cutoffDate || "",
        technicianCount: summary.technicianCount,
        grossSalaryTotal: summary.grossSalaryTotal,
        cashAdvanceTotal: summary.cashAdvanceTotal,
        cashAdvanceCarryOverTotal: summary.cashAdvanceCarryOverTotal,
        netSalaryTotal: summary.netSalaryTotal
      }
    });

    return res.json({ summary, rows });
  } catch (err) {
    return res.status(500).json({ error: err.message });
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
