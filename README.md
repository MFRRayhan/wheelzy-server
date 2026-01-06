# Wheelzy Backend

Wheelzy is a **MERN-based car rental platform** that allows users to rent cars, riders to list their cars, and admins to manage the platform. This repository contains the backend server built with **Node.js, Express.js, MongoDB, Firebase Authentication, and Stripe Payments**.

---

## Table of Contents

- [Wheelzy Backend](#wheelzy-backend)
  - [Table of Contents](#table-of-contents)
  - [Features](#features)
  - [Tech Stack](#tech-stack)
  - [Environment Variables](#environment-variables)
  - [Installation](#installation)
  - [Running the Server](#running-the-server)
  - [API Endpoints](#api-endpoints)
    - [Authentication \& Users](#authentication--users)
    - [Cars](#cars)
    - [Rentals \& Memberships](#rentals--memberships)
    - [Payments](#payments)
    - [Dashboard](#dashboard)
    - [Rider Applications](#rider-applications)
  - [License](#license)

---

## Features

- User roles: `user`, `rider`, `admin`
- Riders can list cars for rent
- Users can rent available cars
- Stripe integration for payments
- Admin panel for managing users, cars, rentals, and payments
- Firebase Authentication for secure token verification
- Dashboard stats for admin, rider, and user
- Memberships management for car rentals
- Ride requests, earnings, and rental tracking for riders

---

## Tech Stack

- **Backend**: Node.js, Express.js
- **Database**: MongoDB
- **Authentication**: Firebase Admin SDK
- **Payment**: Stripe
- **Other Tools**: dotenv, cors, MongoDB Driver

---

## Environment Variables

Create a `.env` file in the project root with the following variables:

```env
PORT=5000
DB_USER=<your-mongodb-username>
DB_PASS=<your-mongodb-password>
STRIPE_SECRET_KEY=<your-stripe-secret-key>
FB_SERVICE_KEY=<your-base64-encoded-firebase-service-account-json>
SITE_DOMAIN=<your-frontend-domain>
```

**Important:** Never commit sensitive files like `wheelzy-firebase-adminsdk.json` to GitHub. Use environment variables instead.

---

## Installation

1. Clone the repository:

```bash
git clone https://github.com/MFRRayhan/wheelzy-server.git
cd wheelzy-server
```

2. Install dependencies:

```bash
npm install
```

3. Create a `.env` file with the required variables (see above).

---

## Running the Server

```bash
npm start
```

Server will run on the port specified in `.env` or default `5000`.

---

## API Endpoints

### Authentication & Users

- `POST /users` → Create or update user
- `GET /users/:email/role` → Get role of a user
- `GET /users` → Admin: Get all users
- `PATCH /users/:id/role` → Admin: Update user role

### Cars

- `POST /cars` → Rider: Add a car
- `PATCH /cars/:id/status` → Admin: Approve/reject car
- `GET /cars` → Get all approved cars (filter by email or status)
- `GET /cars/:id` → Get single car details
- `PATCH /cars/:id` → Update car info
- `DELETE /cars/:id` → Delete car
- `GET /my-cars` → Get cars relevant to logged-in user

### Rentals & Memberships

- `POST /rentals` → Rent a car
- `GET /rentals/active` → Get active rentals
- `PATCH /rentals/cancel/:id` → Cancel a rental
- `GET /rentals/check-status/:carId` → Check if user has active rental
- `GET /memberships/active` → Get active memberships
- `PATCH /memberships/cancel/:id` → Cancel a membership

### Payments

- `POST /create-rental-session` → Stripe checkout session
- `POST /payments` → Save payment record
- `GET /payments/history` → User payment history
- `GET /admin/payments` → Admin: All payments

### Dashboard

- `GET /admin/dashboard-stats` → Admin stats
- `GET /rider/dashboard-stats` → Rider stats
- `GET /user/dashboard-stats` → User stats
- `GET /rider/rental-stats` → Rider rental stats
- `GET /rider/earnings-summary` → Rider earnings
- `GET /rider/car-summary` → Rider car stats
- `GET /rider/payments` → Rider payment list
- `GET /rider/payments-details` → Detailed rider payments
- `GET /rider/ride-requests` → Rider ride requests

### Rider Applications

- `POST /club-riders` → Apply to become a rider
- `GET /admin/rider-applications` → Admin: View applications
- `PATCH /admin/rider-applications/:id` → Admin: Approve/Reject rider

---

## License

This project is **MIT Licensed**.

**Note:** Make sure **Firebase service account JSON** is kept secret and never committed to GitHub. Use `.env` variables for all sensitive keys.
