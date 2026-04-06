const express = require("express");
const router = express.Router();

const controller = require("../Controller/client.controller");

// test
router.get("/", controller.testAPI);

// clients
router.get("/clients", controller.getClients);
router.post("/clients", controller.createClient);
// 🔥 UPDATE (VERY IMPORTANT)
router.put("/clients/:id", controller.updateClient);

// netplans
router.get("/netplans", controller.getNetPlans);


router.get("/test-mikrotik", async (req, res) => {
  try {
    const { getMikrotikConfig } = require("../services/mikrotik");

    const server = await getMikrotikConfig("CCR2116");

    res.json(server);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
module.exports = router;

// const express = require("express");
// const router = express.Router();

// const controller = require("../Controller/client.controller");
// const { protect, authorize } = require("../middleware/auth.middleware");

// // test (public)
// router.get("/", controller.testAPI);

// // 🔒 CLIENTS (admin + user only)
// router.get(
//   "/clients",
//   protect,
//   authorize("admin", "user"),
//   controller.getClients
// );

// // 🔒 CREATE CLIENT (admin only)
// router.post(
//   "/clients",
//   protect,
//   authorize("admin"),
//   controller.createClient
// );

// // 🔒 UPDATE CLIENT (admin only)
// router.put(
//   "/clients/:id",
//   protect,
//   authorize("admin"),
//   controller.updateClient
// );

// // 🔒 NETPLANS (admin + user)
// router.get(
//   "/netplans",
//   protect,
//   authorize("admin", "user"),
//   controller.getNetPlans
// );

// // 🔒 MIKROTIK TEST (admin only)
// router.get(
//   "/test-mikrotik",
//   protect,
//   authorize("admin"),
//   async (req, res) => {
//     try {
//       const { getMikrotikConfig } = require("../services/mikrotik");

//       const server = await getMikrotikConfig("CCR2116");

//       res.json(server);
//     } catch (err) {
//       res.status(500).json({ error: err.message });
//     }
//   }
// );

// module.exports = router;