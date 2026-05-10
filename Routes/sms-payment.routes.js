const express = require("express");

const controller = require("../controller/sms-payment.controller");
const { protect, authorize } = require("../middleware/auth.middleware");

const router = express.Router();

router.post(
  "/sms/send-payment-received",
  protect,
  authorize("ADMIN", "CASHIER"),
  controller.sendPaymentReceivedSms
);

router.post(
  "/sms/send-payment-received-latest/:clientId",
  protect,
  authorize("ADMIN", "CASHIER"),
  controller.sendLatestPaymentReceivedSms
);

module.exports = router;
