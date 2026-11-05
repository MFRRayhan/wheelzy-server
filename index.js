// ------------------------ ENV & MODULES ------------------------
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const admin = require("firebase-admin");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

const app = express();
const port = process.env.PORT || 5000;

// ------------------------ FIREBASE ADMIN INIT ------------------------
const decoded = Buffer.from(process.env.FB_SERVICE_KEY, "base64").toString(
  "utf8",
);
const serviceAccount = JSON.parse(decoded);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// ------------------------ MIDDLEWARE ------------------------
app.use(
  cors({
    origin: [`${process.env.SITE_DOMAIN}`],
    credentials: true,
    optionsSuccessStatus: 200,
  }),
);
app.use(express.json());

// ------------------------ FIREBASE TOKEN VERIFICATION ------------------------
const verifyFBToken = async (req, res, next) => {
  const token = req.headers.authorization;

  if (!token)
    return res.status(401).send({ message: "Unauthorized Access: No Token" });

  try {
    const idToken = token.split(" ")[1];
    const decoded = await admin.auth().verifyIdToken(idToken);
    req.decoded_email = decoded.email;
    next();
  } catch (error) {
    console.error("Token Verification Error:", error.message);
    res.status(401).send({ message: "Unauthorized Access: Invalid Token" });
  }
};

// Generate monthly analytics for the last 6 months.
// dateField: rentalDate or paidAt
// sumField: amount for payments, null for record counts

const getMonthlyAnalytics = async (
  collection,
  dateField,
  filter = {},
  sumField = null,
) => {
  const now = new Date();

  const startDate = new Date(now.getFullYear(), now.getMonth() - 5, 1);

  const monthlyRecords = await collection
    .aggregate([
      {
        $match: filter,
      },
      {
        $addFields: {
          analyticsDate: {
            $convert: {
              input: `$${dateField}`,
              to: "date",
              onError: null,
              onNull: null,
            },
          },
        },
      },
      {
        $match: {
          analyticsDate: { $gte: startDate },
        },
      },
      {
        $group: {
          _id: {
            $dateToString: {
              format: "%Y-%m",
              date: "$analyticsDate",
            },
          },
          value: sumField
            ? { $sum: { $ifNull: [`$${sumField}`, 0] } }
            : { $sum: 1 },
        },
      },
      {
        $sort: { _id: 1 },
      },
    ])
    .toArray();

  const recordsMap = new Map(
    monthlyRecords.map((item) => [item._id, item.value]),
  );

  return Array.from({ length: 6 }, (_, index) => {
    const date = new Date(now.getFullYear(), now.getMonth() - 5 + index, 1);

    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(
      2,
      "0",
    )}`;

    return {
      month: date.toLocaleString("en-US", {
        month: "short",
        year: "2-digit",
      }),
      value: recordsMap.get(key) ?? 0,
    };
  });
};

// Count records grouped by status.
const getStatusAnalytics = async (collection, filter = {}) => {
  return collection
    .aggregate([
      { $match: filter },
      {
        $group: {
          _id: "$status",
          count: { $sum: 1 },
        },
      },
      {
        $project: {
          _id: 0,
          status: "$_id",
          count: 1,
        },
      },
    ])
    .toArray();
};

// ------------------------ MONGODB CONNECTION ------------------------
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.erbrsue.mongodb.net/?appName=Cluster0`;
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

// ------------------------ MAIN RUN FUNCTION ------------------------
async function run() {
  try {
    console.log("MongoDB connected");

    const db = client.db("wheelzy");

    // ------------------------ COLLECTIONS ------------------------
    const carCollection = db.collection("cars");
    const userCollection = db.collection("users");
    const rentalCollection = db.collection("rentals");
    const paymentCollection = db.collection("payments");
    const riderApplicationCollection = db.collection("riderApplications");

    // ------------------------ ROLE VERIFICATION MIDDLEWARE ------------------------
    const verifyAdmin = async (req, res, next) => {
      try {
        const email = req.decoded_email;
        if (!email) return res.status(401).send({ message: "Unauthorized" });

        const user = await userCollection.findOne({ email });
        if (!user || user.role !== "admin") {
          return res.status(403).send({ message: "Forbidden: Admin only" });
        }
        next();
      } catch (error) {
        console.error("verifyAdmin error:", error);
        res.status(500).send({ message: "Admin verification failed" });
      }
    };

    const verifyRider = async (req, res, next) => {
      try {
        const email = req.decoded_email;
        if (!email) return res.status(401).send({ message: "Unauthorized" });

        const user = await userCollection.findOne({ email });
        if (!user || user.role !== "rider") {
          return res.status(403).send({ message: "Forbidden: Rider only" });
        }
        next();
      } catch (error) {
        console.error("verifyRider error:", error);
        res.status(500).send({ message: "Rider verification failed" });
      }
    };

    // ------------------------ CAR APIs ------------------------
    app.post("/cars", verifyFBToken, async (req, res) => {
      const carData = req.body;
      carData.riderEmail = req.decoded_email;
      carData.status = "pending";
      carData.isBooked = false;
      carData.createdAt = new Date().toISOString();
      carData.updatedAt = new Date().toISOString();
      const result = await carCollection.insertOne(carData);
      res.send(result);
    });

    app.patch(
      "/cars/:id/status",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        const { id } = req.params;
        const { status } = req.body; // approved | rejected

        if (!["approved", "rejected"].includes(status)) {
          return res.status(400).json({ message: "Invalid status value" });
        }

        if (!ObjectId.isValid(id)) {
          return res.status(400).json({ message: "Invalid Car ID" });
        }

        try {
          const result = await carCollection.updateOne(
            { _id: new ObjectId(id) },
            { $set: { status, updatedAt: new Date().toISOString() } },
          );

          if (result.matchedCount === 0) {
            return res.status(404).json({ message: "Car not found" });
          }

          const updatedCar = await carCollection.findOne({
            _id: new ObjectId(id),
          });

          res.json({
            message: `Car ${status} successfully`,
            car: updatedCar,
          });
        } catch (err) {
          console.error("Error updating car status:", err);
          res.status(500).json({
            message: "Failed to update car status",
            error: err.message,
          });
        }
      },
    );

    app.get("/cars/:id", async (req, res) => {
      const id = req.params.id;
      const result = await carCollection.findOne({ _id: new ObjectId(id) });
      res.send(result);
    });

    app.get("/cars", async (req, res) => {
      const { email, status } = req.query;
      const query = {};
      query.status = status || "approved";
      if (email) query.riderEmail = email;

      const result = await carCollection
        .find(query)
        .sort({ updatedAt: -1 })
        .toArray();
      res.send(result);
    });

    app.delete("/cars/:id", verifyFBToken, async (req, res) => {
      const carId = req.params.id;
      const email = req.decoded_email;

      if (!ObjectId.isValid(carId))
        return res.status(400).json({ message: "Invalid Car ID" });

      const user = await userCollection.findOne({ email });
      if (!user) return res.status(401).json({ message: "Unauthorized" });

      const car = await carCollection.findOne({ _id: new ObjectId(carId) });
      if (!car) return res.status(404).json({ message: "Car not found" });

      const isAdmin = user.role === "admin";
      const isRiderOwner = user.role === "rider" && car.riderEmail === email;

      if (!isAdmin && !isRiderOwner)
        return res.status(403).json({ message: "Forbidden access" });

      const result = await carCollection.deleteOne({ _id: car._id });
      res.json({
        deletedCount: result.deletedCount,
        message: "Car deleted successfully",
      });
    });

    app.get("/my-cars", verifyFBToken, async (req, res) => {
      const email = req.decoded_email;
      const user = await userCollection.findOne({ email });
      if (!user) return res.status(404).json({ message: "User not found" });

      let cars = [];
      if (user.role === "rider") {
        cars = await carCollection
          .find({ riderEmail: email })
          .sort({ createdAt: -1 })
          .toArray();
      } else if (user.role === "user") {
        const rentals = await rentalCollection
          .find({ userEmail: email, status: "active" })
          .toArray();
        const carIds = rentals.map((r) => new ObjectId(r.carId));
        cars = await carCollection.find({ _id: { $in: carIds } }).toArray();
      } else if (user.role === "admin") {
        cars = await carCollection.find({}).sort({ createdAt: -1 }).toArray();
      }

      res.json(cars);
    });

    app.patch("/cars/:id", verifyFBToken, async (req, res) => {
      const id = req.params.id;
      const updateData = req.body;

      const allowedFields = [
        "carName",
        "description",
        "carType",
        "location",
        "rentalFee",
        "bannerImage",
        "status",
        "isBooked",
      ];

      const setData = {};
      allowedFields.forEach((field) => {
        if (updateData[field] !== undefined) setData[field] = updateData[field];
      });

      setData.updatedAt = new Date().toISOString();

      try {
        const result = await carCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: setData },
        );

        if (result.matchedCount === 0)
          return res.status(404).json({ message: "Car not found" });

        res.json({ message: "Car updated successfully", result });
      } catch (error) {
        res.status(500).json({ message: "Internal Server Error" });
      }
    });

    // ------------------------ RIDER APIs ------------------------
    app.get(
      "/rider/rental-stats",
      verifyFBToken,
      verifyRider,
      async (req, res) => {
        const riderEmail = req.decoded_email;
        const cars = await carCollection.find({ riderEmail }).toArray();
        const carIds = cars.map((c) => c._id.toString());

        const totalRentals = await rentalCollection.countDocuments({
          carId: { $in: carIds },
        });
        const activeRentals = await rentalCollection.countDocuments({
          carId: { $in: carIds },
          status: "active",
        });
        const completedRentals = await rentalCollection.countDocuments({
          carId: { $in: carIds },
          status: "completed",
        });
        const cancelledRentals = await rentalCollection.countDocuments({
          carId: { $in: carIds },
          status: "cancelled",
        });

        res.json({
          totalRentals,
          activeRentals,
          completedRentals,
          cancelledRentals,
        });
      },
    );

    app.get(
      "/rider/earnings-summary",
      verifyFBToken,
      verifyRider,
      async (req, res) => {
        const riderEmail = req.decoded_email;
        const payments = await paymentCollection.find({ riderEmail }).toArray();

        const today = new Date().toISOString().slice(0, 10);
        const month = today.slice(0, 7);

        let todayEarnings = 0,
          monthlyEarnings = 0,
          totalEarnings = 0;
        payments.forEach((p) => {
          totalEarnings += Number(p.amount || 0);
          if (p.paidAt?.startsWith(today))
            todayEarnings += Number(p.amount || 0);
          if (p.paidAt?.startsWith(month))
            monthlyEarnings += Number(p.amount || 0);
        });

        res.json({
          todayEarnings,
          monthlyEarnings,
          totalEarnings,
          pendingPayout: 0,
        });
      },
    );

    app.get(
      "/rider/car-summary",
      verifyFBToken,
      verifyRider,
      async (req, res) => {
        const riderEmail = req.decoded_email;

        const totalCars = await carCollection.countDocuments({ riderEmail });
        const activeCars = await carCollection.countDocuments({
          riderEmail,
          status: "approved",
        });
        const pendingCars = await carCollection.countDocuments({
          riderEmail,
          status: "pending",
        });
        const rejectedCars = await carCollection.countDocuments({
          riderEmail,
          status: "rejected",
        });

        res.json({ totalCars, activeCars, pendingCars, rejectedCars });
      },
    );

    app.get("/rider/payments", verifyFBToken, verifyRider, async (req, res) => {
      try {
        const riderEmail = req.decoded_email;

        const cars = await carCollection.find({ riderEmail }).toArray();
        const carIds = cars.map((c) => c._id.toString());

        if (!carIds.length) return res.json([]);

        const payments = await paymentCollection
          .find({ carId: { $in: carIds } })
          .sort({ paidAt: -1 })
          .toArray();

        res.json(payments);
      } catch (err) {
        console.error("Error fetching rider payments:", err);
        res.status(500).json({ message: "Failed to fetch rider payments" });
      }
    });

    app.get(
      "/rider/payments-details",
      verifyFBToken,
      verifyRider,
      async (req, res) => {
        try {
          const riderEmail = req.decoded_email;

          const cars = await carCollection.find({ riderEmail }).toArray();
          const carIds = cars.map((c) => c._id.toString());

          if (!carIds.length) return res.json([]);

          const rentals = await rentalCollection
            .find({ carId: { $in: carIds } })
            .sort({ rentalDate: -1 })
            .toArray();

          if (!rentals.length) return res.json([]);

          const payments = await paymentCollection
            .find({ carId: { $in: carIds } })
            .toArray();

          const paymentDetails = await Promise.all(
            rentals.map(async (rental) => {
              const car = cars.find((c) => c._id.toString() === rental.carId);
              const payment = payments.find(
                (p) =>
                  p.carId === rental.carId && p.userEmail === rental.userEmail,
              );

              const user = await userCollection.findOne({
                email: rental.userEmail,
              });

              return {
                _id: rental._id,
                carName: car?.carName || "N/A",
                carType: car?.carType || "N/A",
                location: car?.location || "N/A",
                rentalFee: rental.rentalFee,
                rentalStatus: rental.status,
                rentalDate: rental.rentalDate,
                userEmail: rental.userEmail,
                userName: user?.displayName || "N/A",
                userPhone: user?.phone || "N/A",
                paymentAmount: payment?.amount || 0,
                paymentTransaction: payment?.transactionId || "N/A",
                paymentDate: payment?.paidAt || null,
                paymentType: payment?.paymentType || "N/A",
              };
            }),
          );

          res.json(paymentDetails);
        } catch (err) {
          console.error("Error fetching rider payments details:", err);
          res
            .status(500)
            .json({ message: "Failed to fetch rider payments details" });
        }
      },
    );

    // ------------------------ MEMBERSHIP APIs ------------------------

    // Get active memberships for logged-in user
    app.get("/memberships/active", verifyFBToken, async (req, res) => {
      try {
        const userEmail = req.decoded_email;

        // Find all active rentals for this user
        const activeRentals = await rentalCollection
          .find({ userEmail, status: "active" })
          .toArray();

        // Attach car info to each rental
        const memberships = await Promise.all(
          activeRentals.map(async (rental) => {
            const car = await carCollection.findOne({
              _id: new ObjectId(rental.carId),
            });
            return {
              _id: rental._id,
              carId: rental.carId,
              carName: car?.carName || "Unknown Car",
              membershipFee: rental.rentalFee || 0,
              purchaseDate: rental.rentalDate,
              status: rental.status,
            };
          }),
        );

        res.json(memberships);
      } catch (error) {
        console.error("Failed to fetch memberships:", error);
        res.status(500).json({ message: "Failed to fetch memberships" });
      }
    });

    // Cancel a membership (only by the owner)
    app.patch("/memberships/cancel/:id", verifyFBToken, async (req, res) => {
      try {
        const membershipId = req.params.id;
        const userEmail = req.decoded_email;

        if (!ObjectId.isValid(membershipId))
          return res.status(400).json({ message: "Invalid Membership ID" });

        // Find the rental
        const rental = await rentalCollection.findOne({
          _id: new ObjectId(membershipId),
          userEmail,
          status: "active",
        });

        if (!rental)
          return res
            .status(404)
            .json({ message: "Membership not found or already cancelled" });

        // Cancel the rental
        const result = await rentalCollection.updateOne(
          { _id: rental._id },
          {
            $set: {
              status: "cancelled",
              cancelledAt: new Date().toISOString(),
            },
          },
        );

        res.json({ modifiedCount: result.modifiedCount });
      } catch (error) {
        console.error("Failed to cancel membership:", error);
        res.status(500).json({ message: "Failed to cancel membership" });
      }
    });

    // ------------------------ RENTAL APIs ------------------------

    // Create a new rental
    app.post("/rentals", verifyFBToken, async (req, res) => {
      const { carId, carName, rentalFee } = req.body;
      const userEmail = req.decoded_email;

      if (!carId || !carName || rentalFee == null) {
        return res.status(400).send({ message: "Missing required fields" });
      }

      const car = await carCollection.findOne({ _id: new ObjectId(carId) });

      if (!car) {
        return res.status(404).send({ message: "Car not found" });
      }

      // Block if already booked
      if (car.isBooked === true) {
        return res.status(409).send({ message: "This car is already booked" });
      }

      const existing = await rentalCollection.findOne({
        userEmail,
        carId,
        status: "active",
      });

      if (existing) {
        return res.status(409).send({ message: "You already rented this car" });
      }

      const rentalData = {
        carId,
        carName,
        userEmail,
        status: "active",
        rentalFee,
        rentalDate: new Date().toISOString(),
      };

      // ✅ Atomic operation
      const rentalResult = await rentalCollection.insertOne(rentalData);
      const carUpdate = await carCollection.updateOne(
        { _id: new ObjectId(carId), isBooked: false },
        { $set: { isBooked: true, updatedAt: new Date().toISOString() } },
      );

      if (carUpdate.matchedCount === 0) {
        // If car was booked by someone else in the meantime
        await rentalCollection.deleteOne({ _id: rentalResult.insertedId });
        return res
          .status(409)
          .send({ message: "Car was booked by someone else" });
      }

      res.send(rentalResult);
    });

    // Get active rentals for logged-in user
    app.get("/rentals/active", verifyFBToken, async (req, res) => {
      const userEmail = req.decoded_email;
      const activeRentals = await rentalCollection
        .find({ userEmail, status: "active" })
        .toArray();
      res.send(activeRentals);
    });

    // ---------------- NEW: Rental Check Status ----------------
    app.get("/rentals/check-status/:carId", verifyFBToken, async (req, res) => {
      const { carId } = req.params;
      const userEmail = req.decoded_email;

      const rental = await rentalCollection.findOne({
        carId,
        userEmail,
        status: "active",
      });

      res.json({ isMember: !!rental });
    });

    // Cancel a rental
    app.patch("/rentals/cancel/:id", verifyFBToken, async (req, res) => {
      const rentalId = req.params.id;
      const userEmail = req.decoded_email;

      const rental = await rentalCollection.findOne({
        _id: new ObjectId(rentalId),
        userEmail,
        status: "active",
      });

      if (!rental)
        return res
          .status(404)
          .json({ message: "Rental not found or already cancelled" });

      const result = await rentalCollection.updateOne(
        { _id: rental._id },
        {
          $set: { status: "cancelled", cancelledAt: new Date().toISOString() },
        },
      );

      // Update car as available again
      await carCollection.updateOne(
        { _id: new ObjectId(rental.carId) },
        { $set: { isBooked: false, updatedAt: new Date().toISOString() } },
      );

      res.json({ modifiedCount: result.modifiedCount });
    });

    // ------------------------ USER APIs ------------------------

    // Create a new user or update last login
    app.post("/users", async (req, res) => {
      const userData = req.body;
      userData.createdAt = new Date().toISOString();
      userData.lastLoggedIn = new Date().toISOString();
      userData.role = "user"; // default role

      const existing = await userCollection.findOne({ email: userData.email });
      if (existing) {
        await userCollection.updateOne(
          { email: userData.email },
          { $set: { lastLoggedIn: new Date().toISOString() } },
        );
        return res.send({ message: "User updated last login" });
      }

      const result = await userCollection.insertOne(userData);
      res.send(result);
    });

    // Update logged-in user's profile
    app.patch("/users/profile", verifyFBToken, async (req, res) => {
      try {
        const { displayName, photoURL } = req.body;
        const email = req.decoded_email;

        if (!email) {
          return res.status(401).json({
            message: "Unauthorized user",
          });
        }

        if (!displayName || !displayName.trim()) {
          return res.status(400).json({
            message: "Display name is required",
          });
        }

        const result = await userCollection.updateOne(
          { email },
          {
            $set: {
              displayName: displayName.trim(),
              photoURL: photoURL || "",
              updatedAt: new Date().toISOString(),
            },
          },
        );

        if (result.matchedCount === 0) {
          return res.status(404).json({
            message: "User profile not found",
          });
        }

        res.json({
          success: true,
          message: "Profile updated successfully",
        });
      } catch (error) {
        console.error("Profile update error:", error);

        res.status(500).json({
          message: "Failed to update profile",
        });
      }
    });

    // Get role of a user by email
    app.get("/users/:email/role", async (req, res) => {
      const user = await userCollection.findOne({ email: req.params.email });
      if (!user) return res.status(404).json({ message: "User not found" });
      res.json({ role: user.role || "user" });
    });

    // Get all users (admin only, optional search)
    app.get("/users", verifyFBToken, verifyAdmin, async (req, res) => {
      try {
        const { searchText } = req.query;
        const query = {};

        if (searchText) {
          // MongoDB regex search on name or email
          query.$or = [
            { displayName: { $regex: searchText, $options: "i" } },
            { email: { $regex: searchText, $options: "i" } },
          ];
        }

        const users = await userCollection
          .find(query)
          .sort({ createdAt: -1 })
          .toArray();
        res.json(users);
      } catch (error) {
        console.error("Failed to fetch users:", error);
        res.status(500).json({ message: "Failed to fetch users" });
      }
    });

    // Change user role (admin only)
    app.patch(
      "/users/:id/role",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        try {
          const { id } = req.params;
          const { role } = req.body;

          const allowedRoles = ["user", "admin", "rider"];
          if (!allowedRoles.includes(role)) {
            return res.status(400).json({ message: "Invalid role" });
          }

          if (!ObjectId.isValid(id)) {
            return res.status(400).json({ message: "Invalid User ID" });
          }

          const result = await userCollection.updateOne(
            { _id: new ObjectId(id) },
            { $set: { role } },
          );

          if (result.matchedCount === 0) {
            return res.status(404).json({ message: "User not found" });
          }

          res.json({ modifiedCount: result.modifiedCount });
        } catch (error) {
          console.error("Failed to update user role:", error);
          res.status(500).json({ message: "Failed to update user role" });
        }
      },
    );

    // ------------------------ RIDER APPLICATION ------------------------
    app.post("/club-riders", verifyFBToken, async (req, res) => {
      const data = req.body;
      const email = req.decoded_email;

      // prevent duplicate application
      const existing = await riderApplicationCollection.findOne({ email });
      if (existing) {
        return res
          .status(409)
          .json({ message: "You already applied for rider role" });
      }

      const application = {
        ...data,
        email,
        status: "pending",
        createdAt: new Date().toISOString(),
      };

      const result = await riderApplicationCollection.insertOne(application);
      res.send(result);
    });

    // Admin: Get all rider applications
    app.get(
      "/admin/rider-applications",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        const applications = await riderApplicationCollection
          .find({})
          .sort({ createdAt: -1 })
          .toArray();

        res.json(applications);
      },
    );

    // Admin: Approve or Reject Rider
    app.patch(
      "/admin/rider-applications/:id",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        const { id } = req.params;
        const { status } = req.body; // approved | rejected

        if (!["approved", "rejected"].includes(status)) {
          return res.status(400).json({ message: "Invalid status" });
        }

        const application = await riderApplicationCollection.findOne({
          _id: new ObjectId(id),
        });

        if (!application)
          return res.status(404).json({ message: "Application not found" });

        // update application status
        await riderApplicationCollection.updateOne(
          { _id: application._id },
          { $set: { status, reviewedAt: new Date().toISOString() } },
        );

        // if approved → update user role
        if (status === "approved") {
          await userCollection.updateOne(
            { email: application.email },
            { $set: { role: "rider" } },
          );
        }

        res.json({ message: `Rider application ${status}` });
      },
    );

    // ------------------------ STRIPE PAYMENT APIs ------------------------

    // Create Stripe checkout session for a rental
    app.post("/create-rental-session", verifyFBToken, async (req, res) => {
      const { carId } = req.body;
      const userEmail = req.decoded_email;

      if (!carId)
        return res.status(400).json({ message: "Car ID is required" });

      const car = await carCollection.findOne({ _id: new ObjectId(carId) });
      if (!car) return res.status(404).json({ message: "Car not found" });
      if (car.isBooked)
        return res.status(409).json({ message: "Car already booked" });

      const session = await stripe.checkout.sessions.create({
        payment_method_types: ["card"],
        mode: "payment",
        customer_email: userEmail,
        line_items: [
          {
            price_data: {
              currency: "BDT",
              product_data: { name: `Rental - ${car.carName}` },
              unit_amount: Math.round(Number(car.rentalFee) * 100),
            },
            quantity: 1,
          },
        ],
        success_url: `${process.env.SITE_DOMAIN}/cars/${car._id}?payment=success`,
        cancel_url: `${process.env.SITE_DOMAIN}/cars/${car._id}?payment=cancel`,
      });

      res.json({ url: session.url });
    });

    // Save payment record
    app.post("/payments", verifyFBToken, async (req, res) => {
      const { transactionId, amount, paymentType, carId } = req.body;
      const userEmail = req.decoded_email;

      const car = await carCollection.findOne({ _id: new ObjectId(carId) });
      if (!car) return res.status(404).send({ message: "Car not found" });

      const paymentData = {
        transactionId,
        amount,
        paymentType,
        carId,
        carName: car.carName,
        riderEmail: car.riderEmail,
        userEmail,
        paidAt: new Date().toISOString(),
      };

      const result = await paymentCollection.insertOne(paymentData);
      res.status(201).json(result);
    });

    // Get payment history for logged-in user
    app.get("/payments/history", verifyFBToken, async (req, res) => {
      try {
        const userEmail = req.decoded_email;

        // Fetch payments made by this user
        const payments = await paymentCollection
          .find({ userEmail })
          .sort({ paidAt: -1 })
          .toArray();

        res.json(payments);
      } catch (err) {
        console.error("Failed to fetch payment history:", err);
        res.status(500).json({ message: "Failed to fetch payment history" });
      }
    });

    // Admin: Get all payments
    app.get("/admin/payments", verifyFBToken, verifyAdmin, async (req, res) => {
      try {
        const payments = await paymentCollection
          .find({})
          .sort({ paidAt: -1 })
          .toArray();
        res.json(payments);
      } catch (err) {
        console.error("Failed to fetch all payments:", err);
        res.status(500).json({ message: "Failed to fetch all payments" });
      }
    });

    // ------------------------ DASHBOARD APIs ------------------------

    // Admin dashboard stats

    app.get(
      "/admin/dashboard-stats",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        try {
          const [
            totalUsers,
            totalRiders,
            totalCars,
            pendingCars,
            approvedCars,
            rejectedCars,
            totalRentals,
            totalPayments,
            paymentSummary,
            userDistribution,
            carStatusDistribution,
            rentalStatusDistribution,
            monthlyRevenue,
            monthlyRentals,
            recentPayments,
            recentRentals,
          ] = await Promise.all([
            userCollection.countDocuments(),

            userCollection.countDocuments({ role: "rider" }),

            carCollection.countDocuments(),

            carCollection.countDocuments({ status: "pending" }),

            carCollection.countDocuments({ status: "approved" }),

            carCollection.countDocuments({ status: "rejected" }),

            rentalCollection.countDocuments(),

            paymentCollection.countDocuments(),

            paymentCollection
              .aggregate([
                {
                  $group: {
                    _id: null,
                    total: { $sum: "$amount" },
                  },
                },
              ])
              .toArray(),

            userCollection
              .aggregate([
                {
                  $group: {
                    _id: "$role",
                    count: { $sum: 1 },
                  },
                },
                {
                  $project: {
                    _id: 0,
                    role: "$_id",
                    count: 1,
                  },
                },
              ])
              .toArray(),

            getStatusAnalytics(carCollection),

            getStatusAnalytics(rentalCollection),

            getMonthlyAnalytics(paymentCollection, "paidAt", {}, "amount"),

            getMonthlyAnalytics(rentalCollection, "rentalDate"),

            paymentCollection.find({}).sort({ paidAt: -1 }).limit(5).toArray(),

            rentalCollection
              .find({})
              .sort({ rentalDate: -1 })
              .limit(5)
              .toArray(),
          ]);

          const totalRevenue = paymentSummary[0]?.total ?? 0;

          res.json({
            totalUsers,
            totalRiders,
            totalCars,
            pendingCars,
            approvedCars,
            rejectedCars,
            totalRentals,
            totalPayments,
            totalRevenue,

            userDistribution,
            carStatusDistribution,
            rentalStatusDistribution,

            monthlyRevenue,
            monthlyRentals,

            recentPayments,
            recentRentals,
          });
        } catch (error) {
          console.error("Admin dashboard error:", error);

          res.status(500).json({
            message: "Failed to load admin dashboard analytics",
          });
        }
      },
    );

    // Rider dashboard stats

    app.get(
      "/rider/dashboard-stats",
      verifyFBToken,
      verifyRider,
      async (req, res) => {
        try {
          const riderEmail = req.decoded_email;

          const riderCars = await carCollection.find({ riderEmail }).toArray();

          const carIds = riderCars.map((car) => car._id.toString());

          const rentalFilter = {
            carId: { $in: carIds },
          };

          const paymentFilter = { riderEmail };

          const [
            rentalStats,
            paymentSummary,
            totalPayments,
            monthlyEarnings,
            monthlyRentals,
            rentalStatusDistribution,
            recentRentals,
            recentPayments,
          ] = await Promise.all([
            rentalCollection
              .aggregate([
                { $match: rentalFilter },
                {
                  $group: {
                    _id: "$status",
                    count: { $sum: 1 },
                  },
                },
              ])
              .toArray(),

            paymentCollection
              .aggregate([
                { $match: paymentFilter },
                {
                  $group: {
                    _id: null,
                    total: { $sum: "$amount" },
                  },
                },
              ])
              .toArray(),

            paymentCollection.countDocuments(paymentFilter),

            getMonthlyAnalytics(
              paymentCollection,
              "paidAt",
              paymentFilter,
              "amount",
            ),

            getMonthlyAnalytics(rentalCollection, "rentalDate", rentalFilter),

            getStatusAnalytics(rentalCollection, rentalFilter),

            rentalCollection
              .find(rentalFilter)
              .sort({ rentalDate: -1 })
              .limit(5)
              .toArray(),

            paymentCollection
              .find(paymentFilter)
              .sort({ paidAt: -1 })
              .limit(5)
              .toArray(),
          ]);

          const getCount = (status) =>
            rentalStats.find((item) => item._id === status)?.count ?? 0;

          const totalRentals = rentalStats.reduce(
            (total, item) => total + item.count,
            0,
          );

          const totalEarnings = paymentSummary[0]?.total ?? 0;

          const today = new Date();
          const todayKey = today.toISOString().slice(0, 10);

          const monthKey = today.toISOString().slice(0, 7);

          const earningsByPeriod = await paymentCollection
            .aggregate([
              { $match: paymentFilter },
              {
                $addFields: {
                  analyticsDate: {
                    $convert: {
                      input: "$paidAt",
                      to: "date",
                      onError: null,
                      onNull: null,
                    },
                  },
                },
              },
              {
                $match: {
                  analyticsDate: { $ne: null },
                },
              },
              {
                $group: {
                  _id: null,
                  today: {
                    $sum: {
                      $cond: [
                        {
                          $eq: [
                            {
                              $dateToString: {
                                format: "%Y-%m-%d",
                                date: "$analyticsDate",
                                timezone: "Asia/Dhaka",
                              },
                            },
                            todayKey,
                          ],
                        },
                        "$amount",
                        0,
                      ],
                    },
                  },
                  monthly: {
                    $sum: {
                      $cond: [
                        {
                          $eq: [
                            {
                              $dateToString: {
                                format: "%Y-%m",
                                date: "$analyticsDate",
                                timezone: "Asia/Dhaka",
                              },
                            },
                            monthKey,
                          ],
                        },
                        "$amount",
                        0,
                      ],
                    },
                  },
                },
              },
            ])
            .toArray();

          const periodEarnings = earningsByPeriod[0] ?? {
            today: 0,
            monthly: 0,
          };

          res.json({
            totalCars: riderCars.length,

            approvedCars: riderCars.filter((car) => car.status === "approved")
              .length,

            pendingCars: riderCars.filter((car) => car.status === "pending")
              .length,

            rejectedCars: riderCars.filter((car) => car.status === "rejected")
              .length,

            totalRentals,
            activeRentals: getCount("active"),
            completedRentals: getCount("completed"),
            cancelledRentals: getCount("cancelled"),

            totalPayments,
            totalEarnings,
            todayEarnings: periodEarnings.today,
            monthlyEarnings: periodEarnings.monthly,
            monthlyEarningsChart: monthlyEarnings,
            monthlyRentals,
            rentalStatusDistribution,

            recentRentals,
            recentPayments,
          });
        } catch (error) {
          console.error("Rider dashboard error:", error);

          res.status(500).json({
            message: "Failed to load rider dashboard analytics",
          });
        }
      },
    );

    // User dashboard stats

    app.get("/user/dashboard-stats", verifyFBToken, async (req, res) => {
      try {
        const userEmail = req.decoded_email;

        const rentalFilter = { userEmail };
        const paymentFilter = { userEmail };

        const [
          totalRentals,
          activeRentals,
          completedRentals,
          cancelledRentals,
          totalPayments,
          paymentSummary,
          rentalStatusDistribution,
          monthlySpending,
          monthlyRentals,
          recentRentals,
          recentPayments,
        ] = await Promise.all([
          rentalCollection.countDocuments(rentalFilter),

          rentalCollection.countDocuments({
            ...rentalFilter,
            status: "active",
          }),

          rentalCollection.countDocuments({
            ...rentalFilter,
            status: "completed",
          }),

          rentalCollection.countDocuments({
            ...rentalFilter,
            status: "cancelled",
          }),

          paymentCollection.countDocuments(paymentFilter),

          paymentCollection
            .aggregate([
              { $match: paymentFilter },
              {
                $group: {
                  _id: null,
                  total: { $sum: "$amount" },
                },
              },
            ])
            .toArray(),

          getStatusAnalytics(rentalCollection, rentalFilter),

          getMonthlyAnalytics(
            paymentCollection,
            "paidAt",
            paymentFilter,
            "amount",
          ),

          getMonthlyAnalytics(rentalCollection, "rentalDate", rentalFilter),

          rentalCollection
            .find(rentalFilter)
            .sort({ rentalDate: -1 })
            .limit(5)
            .toArray(),

          paymentCollection
            .find(paymentFilter)
            .sort({ paidAt: -1 })
            .limit(5)
            .toArray(),
        ]);

        res.json({
          totalRentals,
          activeRentals,
          completedRentals,
          cancelledRentals,

          totalPayments,
          totalSpent: paymentSummary[0]?.total ?? 0,

          rentalStatusDistribution,
          monthlySpending,
          monthlyRentals,

          recentRentals,
          recentPayments,
        });
      } catch (error) {
        console.error("User dashboard error:", error);

        res.status(500).json({
          message: "Failed to load user dashboard analytics",
        });
      }
    });

    // Rider ride requests
    app.get(
      "/rider/ride-requests",
      verifyFBToken,
      verifyRider,
      async (req, res) => {
        try {
          const riderEmail = req.decoded_email;

          // Rider cars
          const cars = await carCollection.find({ riderEmail }).toArray();
          const carIds = cars.map((c) => c._id.toString());

          // Rentals for those cars
          const rentals = await rentalCollection
            .find({ carId: { $in: carIds } })
            .sort({ rentalDate: -1 })
            .toArray();

          // Payments for rider cars
          const payments = await paymentCollection
            .find({ riderEmail })
            .toArray();

          const result = rentals.map((rental) => {
            const car = cars.find((c) => c._id.toString() === rental.carId);
            const payment = payments.find(
              (p) =>
                p.carId === rental.carId && p.userEmail === rental.userEmail,
            );

            return {
              _id: rental._id,
              carName: car?.carName || "N/A",
              carType: car?.carType || "N/A",
              location: car?.location || "N/A",
              rentalFee: rental.rentalFee,
              paidAmount: payment?.amount || 0,
              transactionId: payment?.transactionId || "N/A",
              status: rental.status,
              userEmail: rental.userEmail,
              rentalDate: rental.rentalDate,
            };
          });

          res.json(result);
        } catch (error) {
          console.error("Ride request fetch error:", error);
          res.status(500).json({ message: "Failed to fetch ride requests" });
        }
      },
    );

    // ─────────────────────────────────────────────────────────────────────
    // DEMO ACCOUNT PROVISIONING
    // POST /provision-demo-accounts?secret=<DEMO_PROVISION_SECRET>
    //
    // Creates the three demo Firebase accounts and upserts their MongoDB
    // documents in one request. Idempotent — safe to call multiple times.
    // Protected by a shared secret so it cannot be triggered by strangers.
    // ─────────────────────────────────────────────────────────────────────
    app.post("/provision-demo-accounts", async (req, res) => {
      // 1. Verify secret
      const { secret } = req.query;
      if (!secret || secret !== process.env.DEMO_PROVISION_SECRET) {
        return res.status(403).json({ message: "Forbidden: invalid secret" });
      }

      const demoAccounts = [
        {
          email: process.env.DEMO_ADMIN_EMAIL,
          password: process.env.DEMO_ADMIN_PASSWORD,
          displayName: "Demo Admin",
          role: "admin",
          photoURL: "https://i.ibb.co.com/TM9j0Rqd/icon-7797704-640.png",
        },
        {
          email: process.env.DEMO_RIDER_EMAIL,
          password: process.env.DEMO_RIDER_PASSWORD,
          displayName: "Demo Rider",
          role: "rider",
          photoURL: "https://i.ibb.co.com/TM9j0Rqd/icon-7797704-640.png",
        },
        {
          email: process.env.DEMO_USER_EMAIL,
          password: process.env.DEMO_USER_PASSWORD,
          displayName: "Demo User",
          role: "user",
          photoURL: "https://i.ibb.co.com/TM9j0Rqd/icon-7797704-640.png",
        },
      ];

      const results = [];

      for (const account of demoAccounts) {
        const result = { email: account.email, role: account.role };

        // ── Step 1: Create or verify Firebase account ──────────────────
        try {
          // Check if Firebase account already exists
          const existingUser = await admin.auth().getUserByEmail(account.email);
          // Account exists — force-update the password and displayName to
          // match exactly what is in .env. This fixes the case where the
          // account was created earlier with a different password.
          await admin.auth().updateUser(existingUser.uid, {
            password: account.password,
            displayName: account.displayName,
            emailVerified: true,
          });
          result.firebase = "exists — password synced";
        } catch (fbErr) {
          if (fbErr.code === "auth/user-not-found") {
            // Create the account fresh
            try {
              await admin.auth().createUser({
                email: account.email,
                password: account.password,
                displayName: account.displayName,
                emailVerified: true,
              });
              result.firebase = "created";
            } catch (createErr) {
              result.firebase = `error: ${createErr.message}`;
            }
          } else {
            result.firebase = `error: ${fbErr.message}`;
          }
        }

        // ── Step 2: Upsert MongoDB document ────────────────────────────
        try {
          const now = new Date().toISOString();
          const upsertResult = await userCollection.updateOne(
            { email: account.email },
            {
              $set: {
                email: account.email,
                displayName: account.displayName,
                photoURL: account.photoURL,
                role: account.role,
                lastLoggedIn: now,
              },
              $setOnInsert: { createdAt: now },
            },
            { upsert: true },
          );

          if (upsertResult.upsertedCount > 0) {
            result.mongodb = "inserted";
          } else if (upsertResult.modifiedCount > 0) {
            result.mongodb = "updated";
          } else {
            result.mongodb = "already up-to-date";
          }
        } catch (dbErr) {
          result.mongodb = `error: ${dbErr.message}`;
        }

        results.push(result);
      }

      return res.json({
        message: "Demo account provisioning complete",
        results,
      });
    });

    // ------------------------ ROOT ------------------------
    app.get("/", (req, res) => {
      res.status(200).json({
        success: true,
        message: "Server is running successfully!",
        status: 200,
        data: {
          name: "Wheelzy API",
          version: "1.0.0",
          environment: process.env.NODE_ENV || "development",
        },
        timestamp: new Date().toISOString(),
      });
    });

    app.listen(port, () => console.log(`Server running on port ${port}`));
  } catch (err) {
    console.error(err);
  }
}

run().catch(console.dir);
