const express = require("express");

const controller = require("../controller/transaction-verification.controller");
const { protect, authorize } = require("../middleware/auth.middleware");

const router = express.Router();

router.get(
  "/transaction-verification",
  protect,
  authorize("ADMIN"),
  controller.getPendingTransactions
);

router.put(
  "/transaction-verification/verify",
  protect,
  authorize("ADMIN"),
  controller.verifyTransactions
);

module.exports = router;
