const express = require("express");
const http = require("http");
const cors = require("cors");

const connectDB = require("./config/db.runtime");
const clientRoutes = require("./Routes/client.route");
const reportRoutes = require("./Routes/report.routes");
const expenseRoutes = require("./Routes/expense.routes");
const napRoutes = require("./Routes/nap.routes");
const netplanRoutes = require("./Routes/netplan.routes");
const smsRoutes = require("./Routes/sms.routes");
const smsGatewayRoutes = require("./Routes/sms-gateway.routes");
const smsBatchRoutes = require("./Routes/sms-batch.routes");
const smsPaymentRoutes = require("./Routes/sms-payment.routes");
const emailNotificationRoutes = require("./Routes/email-notification.routes");
const printReceiptRoutes = require("./Routes/print-receipt.routes");
const systemRoutes = require("./Routes/system.routes");
const transactionVerificationRoutes = require("./Routes/transaction-verification.routes");
const clientBypassRoutes = require("./Routes/client-bypass.routes");
const mikrotikCheckerRoutes = require("./Routes/mikrotik-checker.routes");
const mikrotikConnectionRoutes = require("./Routes/mikrotik-connection.routes");
const mikrotikDcBatchRoutes = require("./Routes/mikrotik-dc-batch.routes");
const mikrotikDueDisconnectBatchRoutes = require("./Routes/mikrotik-due-disconnect-batch.routes");
const { errorHandler } = require("./middleware/error.middleware");
const { startEmailNotificationScheduler } = require("./services/email-notification.service");
const { startMikrotikCheckerScheduler } = require("./services/mikrotik-checker.service");
const { startMikrotikDcBatchScheduler } = require("./services/mikrotik-dc-batch.service");
const {
  startMikrotikDueDisconnectBatchScheduler
} = require("./services/mikrotik-due-disconnect-batch.service");

const app = express();
const server = http.createServer(app);
const helmet = require("helmet");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");
const authRoutes = require("./Routes/auth.routes");
const { initRealtime } = require("./services/realtime.service");

app.use(helmet({ contentSecurityPolicy: false }));
app.use(morgan("dev"));

// middleware
app.use(cors());
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || "2mb" }));
app.use(express.urlencoded({ extended: true, limit: process.env.JSON_BODY_LIMIT || "2mb" }));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.method === "OPTIONS",
});
app.use(limiter);

// routes
app.use("/api", clientRoutes);
app.use("/api", reportRoutes);
app.use("/api", expenseRoutes);
app.use("/api", napRoutes);
app.use("/api", netplanRoutes);
app.use("/api", smsRoutes);
app.use("/api", smsGatewayRoutes);
app.use("/api", smsBatchRoutes);
app.use("/api", smsPaymentRoutes);
app.use("/api", emailNotificationRoutes);
app.use("/api", printReceiptRoutes);
app.use("/api", systemRoutes);
app.use("/api", transactionVerificationRoutes);
app.use("/api", clientBypassRoutes);
app.use("/api", mikrotikCheckerRoutes);
app.use("/api", mikrotikConnectionRoutes);
app.use("/api", mikrotikDcBatchRoutes);
app.use("/api", mikrotikDueDisconnectBatchRoutes);
app.use("/api/auth", authRoutes);

// error handler
app.use(errorHandler);

const PORT = process.env.PORT || 5000;

const startServer = async () => {
  await connectDB();

  startEmailNotificationScheduler();
  startMikrotikCheckerScheduler();
  startMikrotikDcBatchScheduler();
  startMikrotikDueDisconnectBatchScheduler();

  initRealtime(server);

  server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
};

startServer();
