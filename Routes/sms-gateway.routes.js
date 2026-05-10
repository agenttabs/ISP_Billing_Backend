const express = require("express");

const controller = require("../controller/sms-gateway.controller");
const { protect, authorize } = require("../middleware/auth.middleware");

const router = express.Router();

router.get(
  "/sms-gateways",
  protect,
  authorize("ADMIN"),
  controller.getSmsGateways
);

router.post(
  "/sms-gateways",
  protect,
  authorize("ADMIN"),
  controller.createSmsGateway
);

router.put(
  "/sms-gateways/:id",
  protect,
  authorize("ADMIN"),
  controller.updateSmsGateway
);

router.post(
  "/sms-gateways/test",
  protect,
  authorize("ADMIN"),
  controller.testSmsGateway
);

router.delete(
  "/sms-gateways/:id",
  protect,
  authorize("ADMIN"),
  controller.deleteSmsGateway
);

module.exports = router;
