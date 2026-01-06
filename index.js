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
  "utf8"
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
  })
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
            { $set: { status, updatedAt: new Date().toISOString() } }
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
      }
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
          { $set: setData }
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
      }
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
      }
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
      }
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
                  p.carId === rental.carId && p.userEmail === rental.userEmail
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
            })
          );

          res.json(paymentDetails);
        } catch (err) {
          console.error("Error fetching rider payments details:", err);
          res
            .status(500)
            .json({ message: "Failed to fetch rider payments details" });
        }
      }
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
          })
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
          }
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
        { $set: { isBooked: true, updatedAt: new Date().toISOString() } }
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
        { $set: { status: "cancelled", cancelledAt: new Date().toISOString() } }
      );

      // Update car as available again
      await carCollection.updateOne(
        { _id: new ObjectId(rental.carId) },
        { $set: { isBooked: false, updatedAt: new Date().toISOString() } }
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
          { $set: { lastLoggedIn: new Date().toISOString() } }
        );
        return res.send({ message: "User updated last login" });
      }

      const result = await userCollection.insertOne(userData);
      res.send(result);
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
            { $set: { role } }
          );

          if (result.matchedCount === 0) {
            return res.status(404).json({ message: "User not found" });
          }

          res.json({ modifiedCount: result.modifiedCount });
        } catch (error) {
          console.error("Failed to update user role:", error);
          res.status(500).json({ message: "Failed to update user role" });
        }
      }
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
      }
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
          { $set: { status, reviewedAt: new Date().toISOString() } }
        );

        // if approved → update user role
        if (status === "approved") {
          await userCollection.updateOne(
            { email: application.email },
            { $set: { role: "rider" } }
          );
        }

        res.json({ message: `Rider application ${status}` });
      }
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
          const totalUsers = await userCollection.countDocuments();

          const totalCars = await carCollection.countDocuments();
          const pendingCars = await carCollection.countDocuments({
            status: "pending",
          });
          const approvedCars = await carCollection.countDocuments({
            status: "approved",
          });
          const rejectedCars = await carCollection.countDocuments({
            status: "rejected",
          });

          const payments = await paymentCollection.find({}).toArray();
          const totalPayments = payments.length;
          const totalRevenue = payments.reduce(
            (sum, p) => sum + Number(p.amount || 0),
            0
          );

          res.json({
            totalUsers,
            totalCars,
            pendingCars,
            approvedCars,
            rejectedCars,
            totalPayments,
            totalRevenue,
          });
        } catch (error) {
          console.error("Admin dashboard error:", error);
          res.status(500).json({ message: "Failed to load dashboard stats" });
        }
      }
    );

    // Rider dashboard stats
    app.get(
      "/rider/dashboard-stats",
      verifyFBToken,
      verifyRider,
      async (req, res) => {
        const riderEmail = req.decoded_email;
        const managedCars = await carCollection.find({ riderEmail }).toArray();
        const carIds = managedCars.map((c) => c._id.toString());
        const totalRentals = await rentalCollection.countDocuments({
          carId: { $in: carIds },
          status: "active",
        });
        const payments = await paymentCollection
          .find({ carId: { $in: carIds } })
          .toArray();
        const totalRevenue = payments.reduce(
          (sum, p) => sum + Number(p.amount || 0),
          0
        );

        res.json({
          totalCars: managedCars.length,
          totalRentals,
          totalPayments: payments.length,
          totalRevenue,
        });
      }
    );

    // User dashboard stats
    app.get("/user/dashboard-stats", verifyFBToken, async (req, res) => {
      const userEmail = req.decoded_email;

      const activeRentals = await rentalCollection.countDocuments({
        userEmail,
        status: "active",
      });
      const totalRentals = await rentalCollection.countDocuments({ userEmail });

      const payments = await paymentCollection.find({ userEmail }).toArray();
      const totalSpent = payments.reduce(
        (sum, p) => sum + Number(p.amount || 0),
        0
      );

      res.json({
        activeRentals,
        totalRentals,
        totalPayments: payments.length,
        totalSpent,
      });
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
                p.carId === rental.carId && p.userEmail === rental.userEmail
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
      }
    );

    // ------------------------ ROOT ------------------------
    app.get("/", (req, res) => res.send("Hello from Wheelzy Backend"));

    app.listen(port, () => console.log(`Server running on port ${port}`));
  } catch (err) {
    console.error(err);
  }
}

run().catch(console.dir);
