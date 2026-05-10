const express = require("express");

const controller = require("../controller/sms-batch.controller");
const { protect, authorize } = require("../middleware/auth.middleware");

const router = express.Router();

router.get(
  "/sms-batch-programs",
  protect,
  authorize("ADMIN"),
  controller.getSmsBatchPrograms
);

router.post(
  "/sms-batch-programs",
  protect,
  authorize("ADMIN"),
  controller.createSmsBatchProgram
);

router.put(
  "/sms-batch-programs/:id",
  protect,
  authorize("ADMIN"),
  controller.updateSmsBatchProgram
);

router.get(
  "/sms-batch-programs/:id/recipients",
  protect,
  authorize("ADMIN"),
  controller.getSmsBatchProgramRecipients
);

router.post(
  "/sms-batch-programs/:id/run-now",
  protect,
  authorize("ADMIN"),
  controller.runSmsBatchProgramNow
);

module.exports = router;
