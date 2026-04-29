const express = require("express");
const router = express.Router();

const controller = require("../controller/expense.controller");
const { protect, authorize } = require("../middleware/auth.middleware");

router.get(
  "/expenses",
  protect,
  authorize("ADMIN", "CASHIER"),
  controller.getExpenses
);

router.post(
  "/expenses",
  protect,
  authorize("ADMIN", "CASHIER"),
  controller.createExpense
);

router.put(
  "/expenses/:id",
  protect,
  authorize("ADMIN", "CASHIER"),
  controller.updateExpense
);

router.delete(
  "/expenses/:id",
  protect,
  authorize("ADMIN"),
  controller.deleteExpense
);

module.exports = router;
