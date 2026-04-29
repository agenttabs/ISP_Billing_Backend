const express = require("express");

const controller = require("../controller/email-notification.controller");
const { protect, authorize } = require("../middleware/auth.middleware");

const router = express.Router();

router.get(
  "/email-notification",
  protect,
  authorize("ADMIN"),
  controller.getEmailNotificationConfig
);

router.put(
  "/email-notification",
  protect,
  authorize("ADMIN"),
  controller.saveEmailNotificationConfig
);

router.post(
  "/email-notification/run-now",
  protect,
  authorize("ADMIN"),
  controller.runEmailNotificationNow
);

module.exports = router;
