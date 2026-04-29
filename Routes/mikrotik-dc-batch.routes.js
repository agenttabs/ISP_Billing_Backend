const express = require("express");

const controller = require("../controller/mikrotik-dc-batch.controller");
const { protect, authorize } = require("../middleware/auth.middleware");

const router = express.Router();

router.get(
  "/mikrotik-dc-batch/config",
  protect,
  authorize("ADMIN"),
  controller.getMikrotikDcBatchConfig
);

router.put(
  "/mikrotik-dc-batch/config",
  protect,
  authorize("ADMIN"),
  controller.saveMikrotikDcBatchConfig
);

router.get(
  "/mikrotik-dc-batch/report",
  protect,
  authorize("ADMIN"),
  controller.previewMikrotikDcBatch
);

router.post(
  "/mikrotik-dc-batch/run-now",
  protect,
  authorize("ADMIN"),
  controller.runMikrotikDcBatchNow
);

module.exports = router;
