const express = require("express");

const controller = require("../controller/sms.controller");
const { protect, authorize } = require("../middleware/auth.middleware");

const router = express.Router();

router.get(
  "/sms-recepients",
  protect,
  authorize("ADMIN"),
  controller.getSmsRecepients
);

router.post(
  "/sms-recepients",
  protect,
  authorize("ADMIN"),
  controller.createSmsRecepient
);

router.put(
  "/sms-recepients/:id",
  protect,
  authorize("ADMIN"),
  controller.updateSmsRecepient
);

module.exports = router;
