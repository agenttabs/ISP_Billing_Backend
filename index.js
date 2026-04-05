const express = require("express");
const cors = require("cors");

const connectDB = require("./config/db");
const clientRoutes = require("./Routes/client.route");
const { errorHandler } = require("./middleware/error.middleware");

const app = express();
const helmet = require("helmet");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");
const authRoutes = require("./Routes/auth.routes");

app.use(helmet({ contentSecurityPolicy: false }));
app.use(morgan("dev"));


const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
});
app.use(limiter);


// middleware
app.use(cors());
app.use(express.json());

// connect DB
connectDB();

// routes
app.use("/api", clientRoutes);
app.use("/api/auth", authRoutes);

//error handler
app.use(errorHandler);

// start server
app.listen(5000, () => {
  console.log("🚀 Server running on http://localhost:5000");
});