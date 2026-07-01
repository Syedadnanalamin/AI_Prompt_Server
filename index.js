const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const Stripe = require("stripe");

dotenv.config();

const app = express();
const port = process.env.PORT || 8080;

app.use(
    cors({
        origin: [process.env.CLIENT_URL],
        credentials: true,
    })
);

app.use(express.json());

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const client = new MongoClient(process.env.MONGO_URI, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    },
});

const asyncHandler = (fn) => (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
};

async function startServer() {
    await client.connect();

    console.log("MongoDB Connected");

    const db = client.db("AIPrompt");

    const promptsCollection = db.collection("prompts");
    const bookmarksCollection = db.collection("bookmarks");
    const reviewsCollection = db.collection("reviews");
    const reportsCollection = db.collection("reports");
    const paymentsCollection = db.collection("payments");
    const usersCollection = db.collection("user");

    const isAdmin = (req, res, next) => {
        if (req.user?.role === "Admin") {
            return next();
        }

        return res.status(403).send({
            message: "Admin access required",
        });
    };

    const isCreator = (req, res, next) => {
        if (
            req.user?.role === "Creator" ||
            req.user?.role === "Admin"
        ) {
            return next();
        }

        return res.status(403).send({
            message: "Creator access required",
        });
    };

    app.get(
        "/api/prompts",
        asyncHandler(async (req, res) => {
            const {
                search,
                category,
                aiTool,
                difficulty,
                sort,
                page = 1,
                limit = 6,
            } = req.query;

            const query = {
                status: "approved",
            };

            if (search) {
                query.$or = [
                    {
                        title: {
                            $regex: search,
                            $options: "i",
                        },
                    },
                    {
                        aiTool: {
                            $regex: search,
                            $options: "i",
                        },
                    },
                    {
                        tags: {
                            $in: [new RegExp(search, "i")],
                        },
                    },
                ];
            }

            if (category) query.category = category;
            if (aiTool) query.aiTool = aiTool;
            if (difficulty) query.difficulty = difficulty;

            let sortOption = {
                createdAt: -1,
            };

            if (sort === "Most Popular") {
                sortOption = {
                    rating: -1,
                    copyCount: -1,
                };
            }

            if (sort === "Most Copied") {
                sortOption = {
                    copyCount: -1,
                };
            }

            const pageNum = Number(page);
            const limitNum = Number(limit);

            const total = await promptsCollection.countDocuments(query);

            const prompts = await promptsCollection
                .find(query)
                .sort(sortOption)
                .skip((pageNum - 1) * limitNum)
                .limit(limitNum)
                .toArray();

            res.send({
                total,
                pages: Math.ceil(total / limitNum),
                currentPage: pageNum,
                prompts,
            });
        })
    );

    // Featured Prompts
    app.get(
        "/api/prompts/featured",
        asyncHandler(async (req, res) => {
            const prompts = await promptsCollection
                .find({
                    status: "approved",
                    isFeatured: true,
                })
                .limit(6)
                .toArray();

            res.send(prompts);
        })
    );

    // Prompt Details
    app.get(
        "/api/prompts/details/:id",
        asyncHandler(async (req, res) => {
            const { id } = req.params;

            if (!ObjectId.isValid(id)) {
                return res.status(400).send({
                    message: "Invalid Prompt Id",
                });
            }

            const prompt = await promptsCollection.findOne({
                _id: new ObjectId(id),
            });

            if (!prompt) {
                return res.status(404).send({
                    message: "Prompt not found",
                });
            }

            res.send(prompt);
        })
    );

    // Add Prompt (No Middleware)
    app.post(
        "/api/prompts",
        asyncHandler(async (req, res) => {
            const prompt = req.body;

            prompt.copyCount = 0;
            prompt.rating = 0;
            prompt.reviewCount = 0;
            prompt.status = "pending";
            prompt.createdAt = new Date();
            prompt.isFeatured = false;

            const result = await promptsCollection.insertOne(prompt);

            res.send(result);
        })
    );

    // Update Prompt
    app.put(
        "/api/prompts/:id",
        asyncHandler(async (req, res) => {
            const { id } = req.params;

            if (!ObjectId.isValid(id)) {
                return res.status(400).send({
                    message: "Invalid Id",
                });
            }

            const updateData = req.body;

            const result = await promptsCollection.updateOne(
                {
                    _id: new ObjectId(id),
                },
                {
                    $set: {
                        title: updateData.title,
                        description: updateData.description,
                        content: updateData.content,
                        category: updateData.category,
                        aiTool: updateData.aiTool,
                        tags: updateData.tags,
                        difficulty: updateData.difficulty,
                        thumbnail: updateData.thumbnail,
                        visibility: updateData.visibility,
                        status: "pending",
                    },
                }
            );

            res.send(result);
        })
    );

    // Delete Prompt
    app.delete(
        "/api/prompts/:id",
        asyncHandler(async (req, res) => {
            const { id } = req.params;

            if (!ObjectId.isValid(id)) {
                return res.status(400).send({
                    message: "Invalid Id",
                });
            }

            const result = await promptsCollection.deleteOne({
                _id: new ObjectId(id),
            });

            await bookmarksCollection.deleteMany({
                promptId: id,
            });

            res.send(result);
        })
    );

    // Copy Prompt
    app.post(
        "/api/prompts/copy/:id",
        asyncHandler(async (req, res) => {
            const { id } = req.params;

            const result = await promptsCollection.updateOne(
                {
                    _id: new ObjectId(id),
                },
                {
                    $inc: {
                        copyCount: 1,
                    },
                }
            );

            res.send(result);
        })
    );

    // Bookmark Toggle
    app.post(
        "/api/bookmarks/toggle",
        asyncHandler(async (req, res) => {
            const { userId, promptId } = req.body;

            const bookmark = await bookmarksCollection.findOne({
                userId,
                promptId,
            });

            if (bookmark) {
                await bookmarksCollection.deleteOne({
                    userId,
                    promptId,
                });

                return res.send({
                    bookmarked: false,
                });
            }

            await bookmarksCollection.insertOne({
                userId,
                promptId,
                createdAt: new Date(),
            });

            res.send({
                bookmarked: true,
            });
        })
    );

    // ==========================
    // My Bookmarks
    // ==========================

    app.get(
        "/api/bookmarks",
        asyncHandler(async (req, res) => {
            const { userId } = req.query;

            const bookmarks = await bookmarksCollection
                .find({ userId })
                .toArray();

            const ids = bookmarks.map((item) => new ObjectId(item.promptId));

            const prompts = await promptsCollection
                .find({
                    _id: {
                        $in: ids,
                    },
                })
                .toArray();

            res.send(prompts);
        })
    );

    // ==========================
    // Add Review
    // ==========================

    app.post(
        "/api/reviews",
        asyncHandler(async (req, res) => {
            const review = req.body;

            const exists = await reviewsCollection.findOne({
                promptId: review.promptId,
                userId: review.userId,
            });

            if (exists) {
                return res.status(400).send({
                    message: "Already Reviewed",
                });
            }

            review.createdAt = new Date();

            await reviewsCollection.insertOne(review);

            const reviews = await reviewsCollection
                .find({
                    promptId: review.promptId,
                })
                .toArray();

            const total = reviews.reduce(
                (sum, item) => sum + Number(item.rating),
                0
            );

            const avg = total / reviews.length;

            await promptsCollection.updateOne(
                {
                    _id: new ObjectId(review.promptId),
                },
                {
                    $set: {
                        rating: avg,
                        reviewCount: reviews.length,
                    },
                }
            );

            res.send({
                success: true,
                avgRating: avg,
                reviewCount: reviews.length,
            });
        })
    );

    // ==========================
    // Reviews By Prompt
    // ==========================

    app.get(
        "/api/reviews/prompt/:id",
        asyncHandler(async (req, res) => {
            const reviews = await reviewsCollection
                .find({
                    promptId: req.params.id,
                })
                .sort({
                    createdAt: -1,
                })
                .toArray();

            res.send(reviews);
        })
    );

    // ==========================
    // My Reviews
    // ==========================

    app.get(
        "/api/reviews/user",
        asyncHandler(async (req, res) => {
            const { userId } = req.query;

            const reviews = await reviewsCollection
                .aggregate([
                    {
                        $match: {
                            userId,
                        },
                    },
                    {
                        $lookup: {
                            from: "prompts",
                            let: {
                                pid: "$promptId",
                            },
                            pipeline: [
                                {
                                    $match: {
                                        $expr: {
                                            $eq: [
                                                "$_id",
                                                {
                                                    $toObjectId: "$$pid",
                                                },
                                            ],
                                        },
                                    },
                                },
                            ],
                            as: "prompt",
                        },
                    },
                    {
                        $unwind: {
                            path: "$prompt",
                            preserveNullAndEmptyArrays: true,
                        },
                    },
                ])
                .toArray();

            res.send(reviews);
        })
    );

    // ==========================
    // Report Prompt
    // ==========================

    app.post(
        "/api/reports",
        asyncHandler(async (req, res) => {
            const report = req.body;

            report.createdAt = new Date();

            const result = await reportsCollection.insertOne(report);

            res.send(result);
        })
    );

    // ==========================
    // Top Creators
    // ==========================

    app.get(
        "/api/creators/top",
        asyncHandler(async (req, res) => {
            const creators = await promptsCollection
                .aggregate([
                    {
                        $match: {
                            status: "approved",
                        },
                    },
                    {
                        $group: {
                            _id: "$creatorId",
                            creatorName: {
                                $first: "$creatorName",
                            },
                            totalCopies: {
                                $sum: "$copyCount",
                            },
                            totalPrompts: {
                                $sum: 1,
                            },
                        },
                    },
                    {
                        $sort: {
                            totalCopies: -1,
                        },
                    },
                    {
                        $limit: 8,
                    },
                ])
                .toArray();

            for (const creator of creators) {
                const user = await usersCollection.findOne({
                    id: creator._id,
                });

                if (user) {
                    creator.email = user.email;
                    creator.image = user.image;
                }
            }

            res.send(creators);
        })
    );

    // ==========================
    // Creator Analytics
    // ==========================

    app.get(
        "/api/creator/analytics",
        asyncHandler(async (req, res) => {
            const { userId } = req.query;

            const prompts = await promptsCollection
                .find({
                    creatorId: userId,
                })
                .toArray();

            const totalPrompts = prompts.length;

            const totalCopies = prompts.reduce(
                (sum, item) => sum + item.copyCount,
                0
            );

            const ids = prompts.map((item) =>
                item._id.toString()
            );

            const totalBookmarks =
                await bookmarksCollection.countDocuments({
                    promptId: {
                        $in: ids,
                    },
                });

            res.send({
                totalPrompts,
                totalCopies,
                totalBookmarks,
                promptList: prompts,
            });
        })
    );

    // ==========================
    // My Prompts
    // ==========================

    app.get(
        "/api/my-prompts",
        asyncHandler(async (req, res) => {
            const { userId } = req.query;

            const prompts = await promptsCollection
                .find({
                    creatorId: userId,
                })
                .toArray();

            res.send(prompts);
        })
    );

    // =====================================
    // ADMIN : GET ALL USERS
    // =====================================

    app.get(
        "/api/admin/users",
        asyncHandler(async (req, res) => {
            const users = await usersCollection
                .find()
                .toArray();

            res.send(users);
        })
    );

    // =====================================
    // ADMIN : UPDATE ROLE
    // =====================================

    app.put(
        "/api/admin/users/:id/role",
        asyncHandler(async (req, res) => {
            const { id } = req.params;
            const { role } = req.body;

            let query = {};

            if (ObjectId.isValid(id)) {
                query = {
                    _id: new ObjectId(id),
                };
            } else {
                query = {
                    id,
                };
            }

            const result = await usersCollection.updateOne(
                query,
                {
                    $set: {
                        role,
                    },
                }
            );

            res.send(result);
        })
    );

    // =====================================
    // ADMIN : DELETE USER
    // =====================================

    app.delete(
        "/api/admin/users/:id",
        asyncHandler(async (req, res) => {
            const { id } = req.params;

            let query = {};

            if (ObjectId.isValid(id)) {
                query = {
                    _id: new ObjectId(id),
                };
            } else {
                query = {
                    id,
                };
            }

            const result = await usersCollection.deleteOne(query);

            res.send(result);
        })
    );

    // =====================================
    // ADMIN : GET ALL PROMPTS
    // =====================================

    app.get(
        "/api/admin/prompts",
        asyncHandler(async (req, res) => {
            const prompts = await promptsCollection
                .find()
                .toArray();

            res.send(prompts);
        })
    );

    // =====================================
    // ADMIN : APPROVE / REJECT
    // =====================================

    app.put(
        "/api/admin/prompts/:id/status",
        asyncHandler(async (req, res) => {
            const { id } = req.params;
            const { status, feedback } = req.body;

            const update = {
                status,
            };

            if (feedback) {
                update.feedback = feedback;
            }

            const result = await promptsCollection.updateOne(
                {
                    _id: new ObjectId(id),
                },
                {
                    $set: update,
                }
            );

            res.send(result);
        })
    );

    // =====================================
    // ADMIN : FEATURE PROMPT
    // =====================================

    app.put(
        "/api/admin/prompts/:id/feature",
        asyncHandler(async (req, res) => {
            const { id } = req.params;
            const { isFeatured } = req.body;

            const result = await promptsCollection.updateOne(
                {
                    _id: new ObjectId(id),
                },
                {
                    $set: {
                        isFeatured,
                    },
                }
            );

            res.send(result);
        })
    );

    // =====================================
    // ADMIN : PAYMENTS
    // =====================================

    app.get(
        "/api/admin/payments",
        asyncHandler(async (req, res) => {
            const payments = await paymentsCollection
                .find()
                .sort({
                    date: -1,
                })
                .toArray();

            res.send(payments);
        })
    );

    // =====================================
    // ADMIN : REPORTS
    // =====================================

    app.get(
        "/api/admin/reports",
        asyncHandler(async (req, res) => {
            const reports = await reportsCollection.aggregate([
                {
                    $lookup: {
                        from: "prompts",
                        let: {
                            pid: "$promptId",
                        },
                        pipeline: [
                            {
                                $match: {
                                    $expr: {
                                        $eq: [
                                            "$_id",
                                            {
                                                $toObjectId: "$$pid",
                                            },
                                        ],
                                    },
                                },
                            },
                        ],
                        as: "promptDetails",
                    },
                },
                {
                    $unwind: {
                        path: "$promptDetails",
                        preserveNullAndEmptyArrays: true,
                    },
                },
            ]).toArray();

            res.send(reports);
        })
    );

    // =====================================
    // ADMIN : REPORT ACTION
    // =====================================

    app.post(
        "/api/admin/reports/:id/action",
        asyncHandler(async (req, res) => {
            const { id } = req.params;
            const { action, promptId, creatorId } = req.body;

            if (action === "remove") {
                await promptsCollection.deleteOne({
                    _id: new ObjectId(promptId),
                });

                await bookmarksCollection.deleteMany({
                    promptId,
                });

                await reviewsCollection.deleteMany({
                    promptId,
                });
            }

            if (action === "warn") {
                await usersCollection.updateOne(
                    {
                        id: creatorId,
                    },
                    {
                        $inc: {
                            warnings: 1,
                        },
                    }
                );
            }

            const result = await reportsCollection.deleteOne({
                _id: new ObjectId(id),
            });

            res.send(result);
        })
    );

    // =====================================
    // ADMIN ANALYTICS
    // =====================================

    app.get(
        "/api/admin/analytics",
        asyncHandler(async (req, res) => {
            const totalUsers = await usersCollection.countDocuments();

            const totalPrompts = await promptsCollection.countDocuments({
                status: "approved",
            });

            const totalReviews = await reviewsCollection.countDocuments();

            const copyResult = await promptsCollection.aggregate([
                {
                    $group: {
                        _id: null,
                        totalCopies: {
                            $sum: "$copyCount",
                        },
                    },
                },
            ]).toArray();

            res.send({
                totalUsers,
                totalPrompts,
                totalReviews,
                totalCopies: copyResult[0]?.totalCopies || 0,
            });
        })
    );

    // =====================================
    // STRIPE CHECKOUT
    // =====================================

    app.post(
        "/api/payments/checkout",
        asyncHandler(async (req, res) => {
            const { email, userId } = req.body;

            const session = await stripe.checkout.sessions.create({
                payment_method_types: ["card"],
                line_items: [
                    {
                        price_data: {
                            currency: "usd",
                            product_data: {
                                name: "Premium Lifetime Pass",
                                description: "Unlock all premium prompts",
                            },
                            unit_amount: 500,
                        },
                        quantity: 1,
                    },
                ],
                mode: "payment",
                customer_email: email,
                success_url: `${process.env.CLIENT_URL}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
                cancel_url: `${process.env.CLIENT_URL}/payment/cancel`,
                metadata: {
                    userId,
                },
            });

            res.send({
                id: session.id,
                url: session.url,
            });
        })
    );

    // =====================================
    // PAYMENT CONFIRM
    // =====================================

    app.post(
        "/api/payments/confirm",
        asyncHandler(async (req, res) => {
            const { sessionId } = req.body;

            const checkoutSession = await stripe.checkout.sessions.retrieve(sessionId);

            if (checkoutSession.payment_status !== "paid") {
                return res.status(400).send({
                    success: false,
                    message: "Payment not completed",
                });
            }

            const userId = checkoutSession.metadata.userId;

            const alreadyPaid = await paymentsCollection.findOne({
                transactionId: sessionId,
            });

            if (!alreadyPaid) {
                await usersCollection.updateOne(
                    {
                        id: userId,
                    },
                    {
                        $set: {
                            subscription: "Premium",
                        },
                    }
                );

                await paymentsCollection.insertOne({
                    transactionId: sessionId,
                    userId,
                    email: checkoutSession.customer_email,
                    amount: 5,
                    date: new Date(),
                });
            }

            res.send({
                success: true,
                message: "Premium Activated",
            });
        })
    );

    app.use((err, req, res, next) => {
        console.error(err);
        res.status(err.status || 500).send({
            success: false,
            message: err.message || "Internal Server Error",
        });
    });

    app.listen(port, () => {
        console.log(`Server Running On Port ${port}`);
    });
}

startServer().catch((err) => {
    console.error(err);
});