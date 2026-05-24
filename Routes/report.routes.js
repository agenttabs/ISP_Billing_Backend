const express = require("express");
const router = express.Router();

const controller = require("../controller/report.controller");
const { protect, authorize } = require("../middleware/auth.middleware");

router.get(
  "/dashboard/summary",
  protect,
  authorize("ADMIN", "CASHIER", "TECHNICIAN"),
  controller.getDashboardSummary
);

router.get(
  "/dashboard/disconnection-today",
  protect,
  authorize("ADMIN", "CASHIER", "TECHNICIAN"),
  controller.getDashboardDisconnectionToday
);

router.get(
  "/dashboard/due-today",
  protect,
  authorize("ADMIN", "CASHIER", "TECHNICIAN"),
  controller.getDashboardDueToday
);

router.get(
  "/dashboard/past-due-unpaid",
  protect,
  authorize("ADMIN", "CASHIER", "TECHNICIAN"),
  controller.getDashboardPastDueUnpaid
);

router.get(
  "/dashboard/collections/:method",
  protect,
  authorize("ADMIN", "CASHIER"),
  controller.getDashboardCollectionList
);

router.get(
  "/dashboard/expenses-today",
  protect,
  authorize("ADMIN", "CASHIER"),
  controller.getDashboardExpensesToday
);

router.get(
  "/transactions",
  protect,
  authorize("ADMIN", "CASHIER"),
  controller.getTransactions
);

router.get(
  "/reports/expenses-and-earnings",
  protect,
  authorize("ADMIN", "CASHIER"),
  controller.getExpensesAndEarnings
);

router.get(
  "/reports/tech-report",
  protect,
  authorize("ADMIN", "TECHNICIAN"),
  controller.getTechReport
);

router.get(
  "/reports/technician-payroll",
  protect,
  authorize("ADMIN"),
  controller.getTechnicianPayrollReport
);

router.get(
  "/reports/pull-out",
  protect,
  authorize("ADMIN"),
  controller.getPullOutReport
);

router.get(
  "/payments/next-receipt-number",
  protect,
  authorize("ADMIN", "CASHIER"),
  controller.getNextPaymentReceiptNumber
);

router.post(
  "/payments/validate-documents",
  protect,
  authorize("ADMIN", "CASHIER"),
  controller.validatePaymentDocuments
);

router.post(
  "/payments/validate-references",
  protect,
  authorize("ADMIN", "CASHIER"),
  controller.validatePaymentReferences
);

router.post(
  "/transactions",
  protect,
  authorize("ADMIN", "CASHIER"),
  controller.createTransaction
);

router.post(
  "/earnings",
  protect,
  authorize("ADMIN", "CASHIER"),
  controller.createEarning
);

router.post(
  "/payments/rollback",
  protect,
  authorize("ADMIN", "CASHIER"),
  controller.rollbackPaymentSave
);

router.get(
  "/earnings",
  protect,
  authorize("ADMIN", "CASHIER"),
  controller.getEarnings
);

router.delete(
  "/transactions/:id",
  protect,
  authorize("ADMIN"),
  controller.deleteTransactionHistory
);

module.exports = router;
