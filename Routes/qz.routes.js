const express = require("express");

const controller = require("../controller/qz.controller");
const { protect, authorize } = require("../middleware/auth.middleware");

const router = express.Router();

router.get(
  "/qz/certificate",
  protect,
  authorize("ADMIN", "CASHIER"),
  controller.getCertificate
);

router.post(
  "/qz/sign",
  protect,
  authorize("ADMIN", "CASHIER"),
  controller.signRequest
);

module.exports = router;
