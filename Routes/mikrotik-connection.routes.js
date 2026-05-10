const express = require("express");
const controller = require("../controller/mikrotik-connection.controller");
const { protect, authorize } = require("../middleware/auth.middleware");

const router = express.Router();

router.get("/mikrotik-connections", protect, authorize("ADMIN"), controller.getMikrotikConnections);
router.post("/mikrotik-connections", protect, authorize("ADMIN"), controller.saveMikrotikConnection);
router.put("/mikrotik-connections/:id", protect, authorize("ADMIN"), controller.saveMikrotikConnection);
router.delete("/mikrotik-connections/:id", protect, authorize("ADMIN"), controller.deleteMikrotikConnection);
router.post("/mikrotik-connections/test", protect, authorize("ADMIN"), controller.testMikrotikConnection);
router.post("/mikrotik-connections/:id/test", protect, authorize("ADMIN"), controller.testMikrotikConnection);

module.exports = router;
