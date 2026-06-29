const express = require('express');
const app = express();
const port = process.env.PORT || 8080;
const cors = require('cors');
const dotenv = require("dotenv");
dotenv.config();

app.use(cors({
    origin: ["https://ai-prompt-client-rose.vercel.app"],
    credentials: true
}));
app.use(express.json());

const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const client = new MongoClient(process.env.MONGO_URI, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});

async function run() {
    try {
        await client.connect();
        // await client.db("admin").command({ ping: 1 });
        console.log("Pinged your deployment. You successfully connected to MongoDB!");

        const db = client.db("AIPrompt");
        const promptsCollection = db.collection("prompts");
        const bookmarksCollection = db.collection("bookmarks");
        const reviewsCollection = db.collection("reviews");
        const reportsCollection = db.collection("reports");
        const paymentsCollection = db.collection("payments");
        const usersCollection = db.collection("user");

        // Helper: Authenticate session
        async function authenticate(req, res, next) {
            const authHeader = req.headers.authorization;
            if (!authHeader || !authHeader.startsWith("Bearer ")) {
                return res.status(401).send({ message: "Unauthorized: Missing token" });
            }
            const token = authHeader.split(" ")[1];
            try {
                const session = await db.collection("session").findOne({ token });
                if (!session) {
                    return res.status(401).send({ message: "Unauthorized: Invalid session" });
                }
                if (new Date(session.expiresAt) < new Date()) {
                    return res.status(401).send({ message: "Unauthorized: Session expired" });
                }

                const userId = session.userId;
                let userQuery = {};
                try {
                    userQuery = { _id: new ObjectId(userId) };
                } catch (e) {
                    userQuery = { id: userId };
                }
                const user = await usersCollection.findOne({
                    $or: [
                        userQuery,
                        { id: userId },
                        { _id: userId }
                    ]
                });

                if (!user) {
                    return res.status(401).send({ message: "Unauthorized: User not found" });
                }
                req.user = user;
                next();
            } catch (err) {
                console.error("Auth middleware error:", err);
                res.status(500).send({ message: "Authentication error" });
            }
        }

        // Helper: Check Admin Role
        const isAdmin = (req, res, next) => {
            if (req.user && req.user.role === "Admin") {
                next();
            } else {
                res.status(403).send({ message: "Forbidden: Admin access required" });
            }
        };

        // Helper: Check Creator Role
        const isCreator = (req, res, next) => {
            if (req.user && (req.user.role === "Creator" || req.user.role === "Admin")) {
                next();
            } else {
                res.status(403).send({ message: "Forbidden: Creator access required" });
            }
        };

        // 1. GET /api/prompts (Public - with Search, Filter, Sort, Pagination)
        app.get('/api/prompts', async (req, res) => {
            try {
                const { search, category, aiTool, difficulty, sort, page = 1, limit = 6 } = req.query;
                const query = { status: "approved" };

                // Search logic (Title, Tags, AI Tool)
                if (search) {
                    query.$or = [
                        { title: { $regex: search, $options: "i" } },
                        { aiTool: { $regex: search, $options: "i" } },
                        { tags: { $in: [new RegExp(search, "i")] } }
                    ];
                }

                // Filter logic
                if (category) query.category = category;
                if (aiTool) query.aiTool = aiTool;
                if (difficulty) query.difficulty = difficulty;

                // Sorting options
                let sortOption = { createdAt: -1 }; // Default: Latest
                if (sort === "Most Popular") {
                    sortOption = { rating: -1, copyCount: -1 };
                } else if (sort === "Most Copied") {
                    sortOption = { copyCount: -1 };
                } else if (sort === "Latest") {
                    sortOption = { createdAt: -1 };
                }

                const pageNum = parseInt(page);
                const limitNum = parseInt(limit);
                const skip = (pageNum - 1) * limitNum;

                const total = await promptsCollection.countDocuments(query);
                const prompts = await promptsCollection.find(query)
                    .sort(sortOption)
                    .skip(skip)
                    .limit(limitNum)
                    .toArray();

                res.send({
                    total,
                    pages: Math.ceil(total / limitNum),
                    currentPage: pageNum,
                    prompts
                });
            } catch (err) {
                res.status(500).send({ message: err.message });
            }
        });

        // 2. GET /api/prompts/featured (Public - limit 6 featured prompts)
        app.get('/api/prompts/featured', async (req, res) => {
            try {
                const prompts = await promptsCollection.find({ status: "approved", isFeatured: true })
                    .limit(6)
                    .toArray();
                res.send(prompts);
            } catch (err) {
                res.status(500).send({ message: err.message });
            }
        });

        // 3. GET /api/prompts/details/:id (Details Page - blur private prompt if not premium)
        app.get('/api/prompts/details/:id', async (req, res) => {
            try {
                const id = req.params.id;
                if (!ObjectId.isValid(id)) {
                    return res.status(400).send({ message: "Invalid ID format" });
                }
                const prompt = await promptsCollection.findOne({ _id: new ObjectId(id) });
                if (!prompt) return res.status(404).send({ message: "Prompt not found" });

                let hasAccess = false;
                const authHeader = req.headers.authorization;
                if (authHeader && authHeader.startsWith("Bearer ")) {
                    const token = authHeader.split(" ")[1];
                    const session = await db.collection("session").findOne({ token });
                    if (session) {
                        const user = await usersCollection.findOne({
                            $or: [
                                { id: session.userId },
                                { _id: session.userId },
                                { _id: new ObjectId(session.userId) }
                            ]
                        });
                        if (user) {
                            if (prompt.visibility === "Public" || user.subscription === "Premium" || user.role === "Admin" || prompt.creatorId === user.id || prompt.creatorId === user._id.toString()) {
                                hasAccess = true;
                            }
                        }
                    }
                }

                // If private prompt and user lacks premium access, hide the content
                if (prompt.visibility === "Private" && !hasAccess) {
                    prompt.content = "[LOCKED] Upgrade to Premium to view this prompt's details.";
                    prompt.isLocked = true;
                } else {
                    prompt.isLocked = false;
                }

                res.send(prompt);
            } catch (err) {
                res.status(500).send({ message: err.message });
            }
        });

        // 4. POST /api/prompts (Add prompt - validates free user limit of 3 prompts)
        app.post('/api/prompts', authenticate, async (req, res) => {
            try {
                const userId = req.user.id || req.user._id.toString();

                // If user is Free, they can only submit 3 prompts in total
                if (req.user.subscription !== "Premium" && req.user.role !== "Admin") {
                    const count = await promptsCollection.countDocuments({ creatorId: userId });
                    if (count >= 3) {
                        return res.status(400).send({ message: "Free users can add only up to 3 prompts. Upgrade to Premium for unlimited prompt creations!" });
                    }
                }

                const prompt = req.body;
                prompt.creatorId = userId;
                prompt.creatorName = req.user.name;
                prompt.creatorEmail = req.user.email;
                prompt.copyCount = 0;
                prompt.rating = 0;
                prompt.reviewCount = 0;
                prompt.status = "pending"; // Admin approval required
                prompt.createdAt = new Date();
                prompt.isFeatured = false;

                const result = await promptsCollection.insertOne(prompt);
                res.send(result);
            } catch (err) {
                res.status(500).send({ message: err.message });
            }
        });

        // 5. PUT /api/prompts/:id (Update prompt)
        app.put('/api/prompts/:id', authenticate, async (req, res) => {
            try {
                const id = req.params.id;
                const updateData = req.body;
                const prompt = await promptsCollection.findOne({ _id: new ObjectId(id) });
                if (!prompt) return res.status(404).send({ message: "Prompt not found" });

                // Only creator or admin can update
                if (prompt.creatorId !== (req.user.id || req.user._id.toString()) && req.user.role !== "Admin") {
                    return res.status(403).send({ message: "Forbidden: You are not the creator of this prompt" });
                }

                const allowedUpdates = {
                    title: updateData.title,
                    description: updateData.description,
                    content: updateData.content,
                    category: updateData.category,
                    aiTool: updateData.aiTool,
                    tags: updateData.tags,
                    difficulty: updateData.difficulty,
                    thumbnail: updateData.thumbnail,
                    visibility: updateData.visibility
                };

                // Re-flag as pending for creator updates
                if (req.user.role !== "Admin") {
                    allowedUpdates.status = "pending";
                }

                const result = await promptsCollection.updateOne(
                    { _id: new ObjectId(id) },
                    { $set: allowedUpdates }
                );
                res.send(result);
            } catch (err) {
                res.status(500).send({ message: err.message });
            }
        });

        // 6. DELETE /api/prompts/:id (Delete prompt)
        app.delete('/api/prompts/:id', authenticate, async (req, res) => {
            try {
                const id = req.params.id;
                const prompt = await promptsCollection.findOne({ _id: new ObjectId(id) });
                if (!prompt) return res.status(404).send({ message: "Prompt not found" });

                if (prompt.creatorId !== (req.user.id || req.user._id.toString()) && req.user.role !== "Admin") {
                    return res.status(403).send({ message: "Forbidden: You cannot delete this prompt" });
                }

                const result = await promptsCollection.deleteOne({ _id: new ObjectId(id) });
                // Also clean up bookmarks
                await bookmarksCollection.deleteMany({ promptId: id });
                res.send(result);
            } catch (err) {
                res.status(500).send({ message: err.message });
            }
        });

        // 7. POST /api/prompts/copy/:id (Increment copy counter)
        app.post('/api/prompts/copy/:id', authenticate, async (req, res) => {
            try {
                const id = req.params.id;
                const result = await promptsCollection.updateOne(
                    { _id: new ObjectId(id) },
                    { $inc: { copyCount: 1 } }
                );
                res.send(result);
            } catch (err) {
                res.status(500).send({ message: err.message });
            }
        });

        // 8. POST /api/bookmarks/toggle (Toggle bookmarking)
        app.post('/api/bookmarks/toggle', authenticate, async (req, res) => {
            try {
                const { promptId } = req.body;
                const userId = req.user.id || req.user._id.toString();

                const existing = await bookmarksCollection.findOne({ userId, promptId });
                if (existing) {
                    await bookmarksCollection.deleteOne({ userId, promptId });
                    return res.send({ bookmarked: false, message: "Bookmark removed" });
                } else {
                    await bookmarksCollection.insertOne({ userId, promptId, createdAt: new Date() });
                    return res.send({ bookmarked: true, message: "Prompt bookmarked" });
                }
            } catch (err) {
                res.status(500).send({ message: err.message });
            }
        });

        // 9. GET /api/bookmarks (Get list of bookmarked prompts)
        app.get('/api/bookmarks', authenticate, async (req, res) => {
            try {
                const userId = req.user.id || req.user._id.toString();
                const bookmarks = await bookmarksCollection.find({ userId }).toArray();
                const promptIds = bookmarks.map(b => new ObjectId(b.promptId));

                const prompts = await promptsCollection.find({ _id: { $in: promptIds } }).toArray();
                res.send(prompts);
            } catch (err) {
                res.status(500).send({ message: err.message });
            }
        });

        // 10. POST /api/reviews (Add rating & comment)
        app.post('/api/reviews', authenticate, async (req, res) => {
            try {
                const { promptId, rating, comment } = req.body;
                const userId = req.user.id || req.user._id.toString();

                // Prevent multiple reviews on the same prompt by the same user
                const existing = await reviewsCollection.findOne({ promptId, userId });
                if (existing) {
                    return res.status(400).send({ message: "You have already reviewed this prompt" });
                }

                const review = {
                    promptId,
                    userId,
                    name: req.user.name,
                    email: req.user.email,
                    rating: parseInt(rating),
                    comment,
                    createdAt: new Date()
                };

                await reviewsCollection.insertOne(review);

                // Recalculate and update the average rating on the prompt
                const allReviews = await reviewsCollection.find({ promptId }).toArray();
                const totalRating = allReviews.reduce((sum, r) => sum + r.rating, 0);
                const avgRating = totalRating / allReviews.length;

                await promptsCollection.updateOne(
                    { _id: new ObjectId(promptId) },
                    { $set: { rating: avgRating, reviewCount: allReviews.length } }
                );

                res.send({ success: true, avgRating, reviewCount: allReviews.length });
            } catch (err) {
                res.status(500).send({ message: err.message });
            }
        });

        // 11. GET /api/reviews/prompt/:id (Fetch reviews for a prompt)
        app.get('/api/reviews/prompt/:id', async (req, res) => {
            try {
                const promptId = req.params.id;
                const reviews = await reviewsCollection.find({ promptId }).sort({ createdAt: -1 }).toArray();
                res.send(reviews);
            } catch (err) {
                res.status(500).send({ message: err.message });
            }
        });

        // 12. GET /api/reviews/user (Get reviews submitted by current user)
        app.get('/api/reviews/user', authenticate, async (req, res) => {
            try {
                const userId = req.user.id || req.user._id.toString();
                // Join with prompt details to show which prompt was reviewed
                const reviews = await reviewsCollection.aggregate([
                    { $match: { userId } },
                    {
                        $lookup: {
                            from: "prompts",
                            let: { pid: "$promptId" },
                            pipeline: [
                                { $match: { $expr: { $eq: ["$_id", { $toObjectId: "$$pid" }] } } }
                            ],
                            as: "promptDetails"
                        }
                    },
                    { $unwind: { path: "$promptDetails", preserveNullAndEmptyArrays: true } }
                ]).toArray();
                res.send(reviews);
            } catch (err) {
                res.status(500).send({ message: err.message });
            }
        });

        // 13. POST /api/reports (Report a prompt)
        app.post('/api/reports', authenticate, async (req, res) => {
            try {
                const { promptId, reason, description } = req.body;
                const report = {
                    promptId,
                    userId: req.user.id || req.user._id.toString(),
                    name: req.user.name,
                    email: req.user.email,
                    reason,
                    description,
                    createdAt: new Date()
                };
                const result = await reportsCollection.insertOne(report);
                res.send(result);
            } catch (err) {
                res.status(500).send({ message: err.message });
            }
        });

        // 14. GET /api/creators/top (Top creators - using MongoDB Aggregation)
        app.get('/api/creators/top', async (req, res) => {
            try {
                const topCreators = await promptsCollection.aggregate([
                    { $match: { status: "approved" } },
                    {
                        $group: {
                            _id: "$creatorId",
                            totalCopies: { $sum: "$copyCount" },
                            totalPrompts: { $sum: 1 },
                            creatorName: { $first: "$creatorName" }
                        }
                    },
                    { $sort: { totalCopies: -1 } },
                    { $limit: 8 }
                ]).toArray();

                // Fetch creators' user information for avatars
                for (let creator of topCreators) {
                    const u = await usersCollection.findOne({
                        $or: [{ id: creator._id }, { _id: creator._id }]
                    });
                    if (u) {
                        creator.image = u.image || "";
                        creator.email = u.email;
                    }
                }
                res.send(topCreators);
            } catch (err) {
                res.status(500).send({ message: err.message });
            }
        });

        // 15. GET /api/creator/analytics (Creator stats & Recharts timeseries)
        app.get('/api/creator/analytics', authenticate, isCreator, async (req, res) => {
            try {
                const userId = req.user.id || req.user._id.toString();

                const totalPrompts = await promptsCollection.countDocuments({ creatorId: userId });

                // Aggregate total copy counts
                const copiesAgg = await promptsCollection.aggregate([
                    { $match: { creatorId: userId } },
                    { $group: { _id: null, totalCopies: { $sum: "$copyCount" } } }
                ]).toArray();
                const totalCopies = copiesAgg[0]?.totalCopies || 0;

                // Aggregate total bookmarks
                const prompts = await promptsCollection.find({ creatorId: userId }).toArray();
                const promptIds = prompts.map(p => p._id.toString());
                const totalBookmarks = await bookmarksCollection.countDocuments({ promptId: { $in: promptIds } });

                // Aggregation for Recharts: Prompt creation growth and copy growth by prompt
                const promptList = await promptsCollection.find({ creatorId: userId })
                    .project({ title: 1, copyCount: 1, createdAt: 1 })
                    .toArray();

                res.send({
                    totalPrompts,
                    totalCopies,
                    totalBookmarks,
                    promptList
                });
            } catch (err) {
                res.status(500).send({ message: err.message });
            }
        });

        // 16. GET /api/my-prompts (Get currently logged-in user prompts)
        app.get('/api/my-prompts', authenticate, async (req, res) => {
            try {
                const userId = req.user.id || req.user._id.toString();
                const result = await promptsCollection.find({ creatorId: userId }).toArray();
                res.send(result);
            } catch (err) {
                res.status(500).send({ message: err.message });
            }
        });

        // ================= ADMIN DASHBOARD ROUTES =================

        // A1. GET /api/admin/users (Get all users)
        app.get('/api/admin/users', authenticate, isAdmin, async (req, res) => {
            try {
                const users = await usersCollection.find().toArray();
                res.send(users);
            } catch (err) {
                res.status(500).send({ message: err.message });
            }
        });

        // A2. PUT /api/admin/users/:id/role (Change user role)
        app.put('/api/admin/users/:id/role', authenticate, isAdmin, async (req, res) => {
            try {
                const id = req.params.id;
                const { role } = req.body;

                let userQuery = {};
                try {
                    userQuery = { _id: new ObjectId(id) };
                } catch (e) {
                    userQuery = { id: id };
                }

                const result = await usersCollection.updateOne(
                    { $or: [userQuery, { id: id }, { _id: id }] },
                    { $set: { role } }
                );
                res.send(result);
            } catch (err) {
                res.status(500).send({ message: err.message });
            }
        });

        // A3. DELETE /api/admin/users/:id (Delete user)
        app.delete('/api/admin/users/:id', authenticate, isAdmin, async (req, res) => {
            try {
                const id = req.params.id;

                let userQuery = {};
                try {
                    userQuery = { _id: new ObjectId(id) };
                } catch (e) {
                    userQuery = { id: id };
                }

                const result = await usersCollection.deleteOne({
                    $or: [userQuery, { id: id }, { _id: id }]
                });
                res.send(result);
            } catch (err) {
                res.status(500).send({ message: err.message });
            }
        });

        // A4. GET /api/admin/prompts (Get all prompts)
        app.get('/api/admin/prompts', authenticate, isAdmin, async (req, res) => {
            try {
                const prompts = await promptsCollection.find().toArray();
                res.send(prompts);
            } catch (err) {
                res.status(500).send({ message: err.message });
            }
        });

        // A5. PUT /api/admin/prompts/:id/status (Approve/Reject prompt)
        app.put('/api/admin/prompts/:id/status', authenticate, isAdmin, async (req, res) => {
            try {
                const id = req.params.id;
                const { status, feedback } = req.body;

                const updateData = { status };
                if (feedback) {
                    updateData.feedback = feedback;
                }

                const result = await promptsCollection.updateOne(
                    { _id: new ObjectId(id) },
                    { $set: updateData }
                );
                res.send(result);
            } catch (err) {
                res.status(500).send({ message: err.message });
            }
        });

        // A6. PUT /api/admin/prompts/:id/feature (Toggle Feature Prompt)
        app.put('/api/admin/prompts/:id/feature', authenticate, isAdmin, async (req, res) => {
            try {
                const id = req.params.id;
                const { isFeatured } = req.body;

                const result = await promptsCollection.updateOne(
                    { _id: new ObjectId(id) },
                    { $set: { isFeatured } }
                );
                res.send(result);
            } catch (err) {
                res.status(500).send({ message: err.message });
            }
        });

        // A7. GET /api/admin/payments (Get all payment records)
        app.get('/api/admin/payments', authenticate, isAdmin, async (req, res) => {
            try {
                const payments = await paymentsCollection.find().sort({ date: -1 }).toArray();
                res.send(payments);
            } catch (err) {
                res.status(500).send({ message: err.message });
            }
        });

        // A8. GET /api/admin/reports (Get reported prompts)
        app.get('/api/admin/reports', authenticate, isAdmin, async (req, res) => {
            try {
                const reports = await reportsCollection.aggregate([
                    {
                        $lookup: {
                            from: "prompts",
                            let: { pid: "$promptId" },
                            pipeline: [
                                { $match: { $expr: { $eq: ["$_id", { $toObjectId: "$$pid" }] } } }
                            ],
                            as: "promptDetails"
                        }
                    },
                    { $unwind: { path: "$promptDetails", preserveNullAndEmptyArrays: true } }
                ]).toArray();
                res.send(reports);
            } catch (err) {
                res.status(500).send({ message: err.message });
            }
        });

        // A9. POST /api/admin/reports/:id/action (Remove Prompt, Warn Creator, Dismiss)
        app.post('/api/admin/reports/:id/action', authenticate, isAdmin, async (req, res) => {
            try {
                const reportId = req.params.id;
                const { action, promptId, creatorId } = req.body;

                if (action === "remove") {
                    await promptsCollection.deleteOne({ _id: new ObjectId(promptId) });
                    await bookmarksCollection.deleteMany({ promptId });
                    await reviewsCollection.deleteMany({ promptId });
                } else if (action === "warn") {
                    // Update user warnings count
                    let userQuery = {};
                    try {
                        userQuery = { _id: new ObjectId(creatorId) };
                    } catch (e) {
                        userQuery = { id: creatorId };
                    }
                    await usersCollection.updateOne(
                        { $or: [userQuery, { id: creatorId }, { _id: creatorId }] },
                        { $inc: { warnings: 1 } }
                    );
                }

                // Delete the resolved report from database
                const result = await reportsCollection.deleteOne({ _id: new ObjectId(reportId) });
                res.send(result);
            } catch (err) {
                res.status(500).send({ message: err.message });
            }
        });

        // A10. GET /api/admin/analytics (Admin Global Analytics - using Aggregation)
        app.get('/api/admin/analytics', authenticate, isAdmin, async (req, res) => {
            try {
                const totalUsers = await usersCollection.countDocuments();
                const totalPrompts = await promptsCollection.countDocuments({ status: "approved" });
                const totalReviews = await reviewsCollection.countDocuments();

                // Aggregate copies sum
                const copiesAgg = await promptsCollection.aggregate([
                    { $group: { _id: null, totalCopies: { $sum: "$copyCount" } } }
                ]).toArray();
                const totalCopies = copiesAgg[0]?.totalCopies || 0;

                res.send({
                    totalUsers,
                    totalPrompts,
                    totalReviews,
                    totalCopies
                });
            } catch (err) {
                res.status(500).send({ message: err.message });
            }
        });

        // ================= STRIPE INTEGRATION ROUTES =================

        // S1. Create checkout session
        app.post('/api/payments/checkout', authenticate, async (req, res) => {
            try {
                const userId = req.user.id || req.user._id.toString();
                const session = await stripe.checkout.sessions.create({
                    payment_method_types: ['card'],
                    line_items: [{
                        price_data: {
                            currency: 'usd',
                            product_data: {
                                name: 'Premium Lifetime Pass',
                                description: 'Unlock all private prompts and get unlimited prompt uploads.',
                            },
                            unit_amount: 500, // $5.00
                        },
                        quantity: 1,
                    }],
                    mode: 'payment',
                    success_url: `${process.env.CLIENT_URL || 'http://localhost:3000'}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
                    cancel_url: `${process.env.CLIENT_URL || 'http://localhost:3000'}/payment/cancel`,
                    customer_email: req.user.email,
                    metadata: {
                        userId: userId
                    }
                });
                res.send({ id: session.id, url: session.url });
            } catch (err) {
                console.error("Stripe error:", err);
                res.status(500).send({ message: err.message });
            }
        });

        // S2. Confirm payment
        app.post('/api/payments/confirm', authenticate, async (req, res) => {
            const { sessionId } = req.body;
            try {
                const checkoutSession = await stripe.checkout.sessions.retrieve(sessionId);
                if (checkoutSession.payment_status === 'paid') {
                    const userId = checkoutSession.metadata.userId;

                    const existingPayment = await paymentsCollection.findOne({ transactionId: sessionId });
                    if (!existingPayment) {
                        let userQuery = {};
                        try {
                            userQuery = { _id: new ObjectId(userId) };
                        } catch (e) {
                            userQuery = { id: userId };
                        }

                        // Update subscription status to Premium
                        await usersCollection.updateOne(
                            { $or: [userQuery, { id: userId }, { _id: userId }] },
                            { $set: { subscription: 'Premium' } }
                        );

                        // Insert transaction details
                        await paymentsCollection.insertOne({
                            transactionId: sessionId,
                            userId: userId,
                            email: checkoutSession.customer_email || req.user.email,
                            amount: 5,
                            date: new Date(),
                        });
                    }
                    res.send({ success: true, message: "Subscription upgraded to Premium!" });
                } else {
                    res.status(400).send({ message: "Payment checkout session not paid." });
                }
            } catch (err) {
                res.status(500).send({ message: err.message });
            }
        });

    } finally {
        // keep client open
    }
}
run().catch(console.dir);

app.listen(port, () => {
    console.log(`Express server listening on port ${port}`);
});
