const express = require("express");

const controller = require("../controller/print-receipt.controller");
const { protect, authorize } = require("../middleware/auth.middleware");

const router = express.Router();

router.get(
  "/print-receipt",
  protect,
  authorize("ADMIN", "CASHIER"),
  controller.getPrintReceiptConfig
);

router.put(
  "/print-receipt",
  protect,
  authorize("ADMIN"),
  controller.savePrintReceiptConfig
);

module.exports = router;
