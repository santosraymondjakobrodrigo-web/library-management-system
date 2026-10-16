
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { promisify } = require('util');
const { MongoClient } = require('mongodb');

const scrypt = promisify(crypto.scrypt);

const app = express();
const PORT = process.env.PORT || 3000;

// ==========================================
// MONGODB ATLAS
// ==========================================
let mongoClient = null;
let db = null;
let mongoConnected = false;

const COLLECTIONS = {
    books: 'books',
    members: 'members',
    loans: 'loans',
    users: 'users',
    counters: 'counters'
};

app.use(cors());
app.use(express.json({ limit: '1mb' }));

// ==========================================
// GENERAL HELPERS
// ==========================================
function today() {
    return new Date().toISOString().slice(0, 10);
}

function isNonEmptyString(value) {
    return typeof value === 'string' && value.trim().length > 0;
}

function cleanDocument(document) {
    if (!document) return null;

    const { _id, passwordHash, passwordSalt, ...safe } = document;
    return safe;
}

function cleanDocuments(documents) {
    return documents.map(cleanDocument);
}

function databaseRequired(req, res, next) {
    if (!mongoConnected || !db) {
        return res.status(503).json({
            error: 'Database is not connected. Please try again shortly.'
        });
    }

    next();
}

// Apply database availability check to API routes.
// Health check remains accessible when Atlas is offline.
app.use('/api', (req, res, next) => {
    if (req.path === '/health') return next();
    databaseRequired(req, res, next);
});

async function getNextSequence(name, currentMax = 0) {
    await db.collection(COLLECTIONS.counters).updateOne(
        { _id: name },
        { $max: { seq: currentMax } },
        { upsert: true }
    );

    const result = await db.collection(COLLECTIONS.counters)
        .findOneAndUpdate(
            { _id: name },
            { $inc: { seq: 1 } },
            { returnDocument: 'after' }
        );

    return result.seq;
}

async function findBook(id) {
    return db.collection(COLLECTIONS.books).findOne({
        $or: [
            { bookId: String(id) },
            { id: String(id) }
        ]
    });
}

async function findMember(id) {
    return db.collection(COLLECTIONS.members).findOne({
        $or: [
            { id: String(id) },
            { memberId: String(id) }
        ]
    });
}

async function findLoan(id) {
    return db.collection(COLLECTIONS.loans).findOne({
        id: String(id)
    });
}

function getLoanResponse(loan) {
    const isOverdue =
        loan.status === 'Active' &&
        loan.dueDate < today();

    return {
        ...cleanDocument(loan),
        status: loan.status === 'Returned'
            ? 'Returned'
            : isOverdue
                ? 'Overdue'
                : 'Active'
    };
}

async function validateBook(body, existingBook = null) {
    if (!isNonEmptyString(body.title)) {
        return 'Book title is required.';
    }

    if (!isNonEmptyString(body.author)) {
        return 'Author is required.';
    }

    const totalCopies = Number(
        body.totalCopies ?? existingBook?.totalCopies ?? 1
    );

    if (!Number.isInteger(totalCopies) || totalCopies < 1) {
        return 'Total copies must be a positive whole number.';
    }

    const isbn = String(body.isbn ?? '').trim();

    if (isbn) {
        const query = {
            isbn: { $regex: `^${escapeRegex(isbn)}$`, $options: 'i' }
        };

        if (existingBook) {
            query.bookId = { $ne: String(existingBook.bookId) };
        }

        const duplicate = await db.collection(COLLECTIONS.books)
            .findOne(query);

        if (duplicate) {
            return 'A book with this ISBN already exists.';
        }
    }

    return null;
}

function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function validDate(value) {
    if (typeof value !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        return false;
    }

    const date = new Date(`${value}T00:00:00.000Z`);

    return !Number.isNaN(date.getTime()) &&
        date.toISOString().slice(0, 10) === value;
}

function handleError(res, error) {
    console.error('API error:', error);

    if (error.code === 11000) {
        return res.status(409).json({
            error: 'A record with that unique value already exists.'
        });
    }

    return res.status(500).json({
        error: 'Internal server error.'
    });
}

// ==========================================
// HEALTH CHECK
// ==========================================
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        message: 'ARCHIVE LMS API is running.',
        database: mongoConnected ? 'connected' : 'disconnected',
        timestamp: new Date().toISOString()
    });
});

// ==========================================
// BOOKS API
// ==========================================

// GET all books
app.get('/api/books', async (req, res) => {
    try {
        const books = await db.collection(COLLECTIONS.books)
            .find({})
            .sort({ bookId: 1 })
            .toArray();

        res.json(cleanDocuments(books));
    } catch (error) {
        handleError(res, error);
    }
});

// GET one book
app.get('/api/books/:id', async (req, res) => {
    try {
        const book = await findBook(req.params.id);

        if (!book) {
            return res.status(404).json({ error: 'Book not found.' });
        }

        res.json(cleanDocument(book));
    } catch (error) {
        handleError(res, error);
    }
});

// ADD a book
app.post('/api/books', async (req, res) => {
    try {
        const error = await validateBook(req.body);

        if (error) {
            return res.status(400).json({ error });
        }

        const totalCopies = Number(req.body.totalCopies ?? 1);

        const existingBooks = await db.collection(COLLECTIONS.books)
            .find({}, { projection: { bookId: 1 } })
            .toArray();

        const maxId = existingBooks.reduce((max, book) => {
            const id = Number(book.bookId);
            return Number.isInteger(id) ? Math.max(max, id) : max;
        }, 100);

        const nextId = await getNextSequence('bookId', maxId);

        const book = {
            bookId: String(nextId),
            title: req.body.title.trim(),
            author: req.body.author.trim(),
            isbn: String(req.body.isbn ?? '').trim(),
            genre: String(req.body.genre ?? 'Uncategorized').trim(),
            totalCopies,
            availableCopies: totalCopies,
            shelf: String(req.body.shelf ?? '').trim()
        };

        await db.collection(COLLECTIONS.books).insertOne(book);

        res.status(201).json({
            message: 'Book added successfully.',
            book
        });
    } catch (error) {
        handleError(res, error);
    }
});

// EDIT a book
app.put('/api/books/:id', async (req, res) => {
    try {
        const book = await findBook(req.params.id);

        if (!book) {
            return res.status(404).json({ error: 'Book not found.' });
        }

        const error = await validateBook(req.body, book);

        if (error) {
            return res.status(400).json({ error });
        }

        const checkedOut = await db.collection(COLLECTIONS.loans)
            .countDocuments({
                bookId: String(book.bookId ?? book.id),
                status: 'Active'
            });

        const totalCopies = Number(
            req.body.totalCopies ?? book.totalCopies
        );

        if (totalCopies < checkedOut) {
            return res.status(400).json({
                error: `At least ${checkedOut} total copies are required because those copies are on loan.`
            });
        }

        const updatedBook = {
            ...book,
            title: req.body.title.trim(),
            author: req.body.author.trim(),
            isbn: String(req.body.isbn ?? '').trim(),
            genre: String(req.body.genre ?? book.genre).trim(),
            shelf: String(req.body.shelf ?? book.shelf).trim(),
            totalCopies,
            availableCopies: totalCopies - checkedOut
        };

        delete updatedBook._id;

        await db.collection(COLLECTIONS.books).replaceOne(
            { _id: book._id },
            updatedBook
        );

        res.json({
            message: 'Book updated successfully.',
            book: updatedBook
        });
    } catch (error) {
        handleError(res, error);
    }
});

// ==========================================
// MEMBERS API
// ==========================================

// GET all members
app.get('/api/members', async (req, res) => {
    try {
        const members = await db.collection(COLLECTIONS.members)
            .find({})
            .sort({ id: 1 })
            .toArray();

        res.json(cleanDocuments(members));
    } catch (error) {
        handleError(res, error);
    }
});

// GET one member
app.get('/api/members/:id', async (req, res) => {
    try {
        const member = await findMember(req.params.id);

        if (!member) {
            return res.status(404).json({ error: 'Member not found.' });
        }

        res.json(cleanDocument(member));
    } catch (error) {
        handleError(res, error);
    }
});

// REGISTER a member
app.post('/api/members', async (req, res) => {
    try {
        const { name, email } = req.body;

        if (!isNonEmptyString(name)) {
            return res.status(400).json({ error: 'Member name is required.' });
        }

        if (!isNonEmptyString(email)) {
            return res.status(400).json({ error: 'Member email is required.' });
        }

        const normalizedEmail = email.trim().toLowerCase();

        const duplicate = await db.collection(COLLECTIONS.members)
            .findOne({ email: normalizedEmail });

        if (duplicate) {
            return res.status(409).json({
                error: 'A member with this email already exists.'
            });
        }

        const existingMembers = await db.collection(COLLECTIONS.members)
            .find({}, { projection: { id: 1 } })
            .toArray();

        const maxId = existingMembers.reduce((max, member) => {
            const match = String(member.id).match(/^M-(\d+)$/);
            return match ? Math.max(max, Number(match[1])) : max;
        }, 0);

        const nextId = await getNextSequence('memberId', maxId);

        const member = {
            id: `M-${String(nextId).padStart(3, '0')}`,
            name: name.trim(),
            email: normalizedEmail,
            status: 'Active',
            fineBalance: 0
        };

        await db.collection(COLLECTIONS.members).insertOne(member);

        res.status(201).json({
            message: 'Member registered successfully.',
            member
        });
    } catch (error) {
        handleError(res, error);
    }
});

// ==========================================
// LOANS API
// ==========================================

// GET all loans
app.get('/api/loans', async (req, res) => {
    try {
        const loans = await db.collection(COLLECTIONS.loans)
            .find({})
            .sort({ id: 1 })
            .toArray();

        res.json(loans.map(getLoanResponse));
    } catch (error) {
        handleError(res, error);
    }
});

// GET one loan
app.get('/api/loans/:id', async (req, res) => {
    try {
        const loan = await findLoan(req.params.id);

        if (!loan) {
            return res.status(404).json({ error: 'Loan not found.' });
        }

        res.json(getLoanResponse(loan));
    } catch (error) {
        handleError(res, error);
    }
});

// BORROW a book
app.post('/api/loans', async (req, res) => {
    try {
        const { memberId, bookId, borrowDate, dueDate } = req.body;

        if (!memberId || !bookId || !borrowDate || !dueDate) {
            return res.status(400).json({
                error: 'Member, book, borrow date, and due date are required.'
            });
        }

        if (!validDate(borrowDate) || !validDate(dueDate)) {
            return res.status(400).json({
                error: 'Dates must use YYYY-MM-DD format.'
            });
        }

        if (dueDate < borrowDate) {
            return res.status(400).json({
                error: 'Due date cannot be before the borrow date.'
            });
        }

        const member = await findMember(memberId);
        const book = await findBook(bookId);

        if (!member) {
            return res.status(404).json({ error: 'Member not found.' });
        }

        if (member.status !== 'Active') {
            return res.status(400).json({
                error: 'This member is not active.'
            });
        }

        if (!book) {
            return res.status(404).json({ error: 'Book not found.' });
        }

        // Atomically reserve one available copy.
        const reservation = await db.collection(COLLECTIONS.books)
            .updateOne(
                {
                    _id: book._id,
                    availableCopies: { $gte: 1 }
                },
                { $inc: { availableCopies: -1 } }
            );

        if (reservation.modifiedCount !== 1) {
            return res.status(400).json({
                error: 'No available copies for this book.'
            });
        }

        try {
            const existingLoans = await db.collection(COLLECTIONS.loans)
                .find({}, { projection: { id: 1 } })
                .toArray();

            const maxId = existingLoans.reduce((max, loan) => {
                const id = Number(loan.id);
                return Number.isInteger(id) ? Math.max(max, id) : max;
            }, 0);

            const nextId = await getNextSequence('loanId', maxId);

            const loan = {
                id: String(nextId),
                memberId: String(member.id),
                memberName: member.name,
                bookId: String(book.bookId ?? book.id),
                bookTitle: book.title,
                borrowDate,
                dueDate,
                returnDate: null,
                status: 'Active'
            };

            await db.collection(COLLECTIONS.loans).insertOne(loan);

            return res.status(201).json({
                message: 'Loan created successfully.',
                loan: getLoanResponse(loan)
            });
        } catch (error) {
            // Restore the copy if creating the loan fails.
            await db.collection(COLLECTIONS.books).updateOne(
                { _id: book._id },
                { $inc: { availableCopies: 1 } }
            );
            throw error;
        }
    } catch (error) {
        handleError(res, error);
    }
});

// RETURN a borrowed book
app.patch('/api/loans/:id/return', async (req, res) => {
    try {
        const loan = await findLoan(req.params.id);

        if (!loan) {
            return res.status(404).json({ error: 'Loan not found.' });
        }

        if (loan.status === 'Returned') {
            return res.status(400).json({
                error: 'This book has already been returned.'
            });
        }

        const book = await findBook(loan.bookId);

        if (!book) {
            return res.status(404).json({
                error: 'Associated book not found.'
            });
        }

        const returnDate = req.body?.returnDate || today();

        if (!validDate(returnDate)) {
            return res.status(400).json({
                error: 'Return date must use YYYY-MM-DD format.'
            });
        }

        // Change loan status only if it has not already been returned.
        const updatedLoan = await db.collection(COLLECTIONS.loans)
            .findOneAndUpdate(
                { _id: loan._id, status: 'Active' },
                {
                    $set: {
                        returnDate,
                        status: 'Returned'
                    }
                },
                { returnDocument: 'after' }
            );

        if (!updatedLoan) {
            return res.status(400).json({
                error: 'This loan has already been returned.'
            });
        }

        await db.collection(COLLECTIONS.books).updateOne(
            { _id: book._id },
            [
                {
                    $set: {
                        availableCopies: {
                            $min: [
                                '$totalCopies',
                                { $add: ['$availableCopies', 1] }
                            ]
                        }
                    }
                }
            ]
        );

        res.json({
            message: 'Book returned successfully.',
            loan: getLoanResponse(updatedLoan)
        });
    } catch (error) {
        handleError(res, error);
    }
});

// ==========================================
// AUTHENTICATION
// Passwords are stored as salted scrypt hashes.
// ==========================================
async function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
    const derivedKey = await scrypt(password, salt, 64);

    return {
        passwordSalt: salt,
        passwordHash: derivedKey.toString('hex')
    };
}

async function verifyPassword(password, user) {
    if (!user.passwordHash || !user.passwordSalt) {
        return false;
    }

    const derivedKey = await scrypt(password, user.passwordSalt, 64);
    const storedKey = Buffer.from(user.passwordHash, 'hex');

    return storedKey.length === derivedKey.length &&
        crypto.timingSafeEqual(storedKey, derivedKey);
}

// REGISTER
app.post('/api/register', async (req, res) => {
    try {
        const { name, role, email, password } = req.body;

        if (
            !isNonEmptyString(name) ||
            !isNonEmptyString(email) ||
            !isNonEmptyString(password)
        ) {
            return res.status(400).json({
                error: 'Name, email, and password are required.'
            });
        }

        if (password.length < 8) {
            return res.status(400).json({
                error: 'Password must be at least 8 characters.'
            });
        }

        const normalizedEmail = email.trim().toLowerCase();

        const existingUser = await db.collection(COLLECTIONS.users)
            .findOne({ email: normalizedEmail });

        if (existingUser) {
            return res.status(409).json({
                error: 'Email is already registered.'
            });
        }

        const allowedRoles = ['Main Librarian', 'Librarian'];
        const safeRole = allowedRoles.includes(role) ? role : 'Librarian';
        const passwordFields = await hashPassword(password);

        const newUser = {
            name: name.trim(),
            role: safeRole,
            email: normalizedEmail,
            ...passwordFields,
            createdAt: new Date()
        };

        await db.collection(COLLECTIONS.users).insertOne(newUser);

        res.status(201).json({
            message: 'Account created successfully.',
            user: {
                name: newUser.name,
                role: newUser.role,
                email: newUser.email
            }
        });
    } catch (error) {
        handleError(res, error);
    }
});

// LOGIN
app.post('/api/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!isNonEmptyString(email) || !isNonEmptyString(password)) {
            return res.status(400).json({
                error: 'Email and password are required.'
            });
        }

        const normalizedEmail = email.trim().toLowerCase();

        const user = await db.collection(COLLECTIONS.users)
            .findOne({ email: normalizedEmail });

        if (!user || !(await verifyPassword(password, user))) {
            return res.status(401).json({
                error: 'Invalid email address or password.'
            });
        }

        res.json({
            message: 'Login successful.',
            user: {
                name: user.name,
                role: user.role,
                email: user.email
            }
        });
    } catch (error) {
        handleError(res, error);
    }
});

// ==========================================
// FRONTEND ROUTING
// ==========================================
const loginFile = path.join(__dirname, 'login.html');
const dashboardFile = path.join(__dirname, 'lms.html');

app.get('/', (req, res) => {
    if (!fs.existsSync(loginFile)) {
        return res.status(500).send('login.html was not found.');
    }

    res.sendFile(loginFile);
});

app.get('/login.html', (req, res) => {
    if (!fs.existsSync(loginFile)) {
        return res.status(404).send('login.html was not found.');
    }

    res.sendFile(loginFile);
});

app.get('/lms.html', (req, res) => {
    if (!fs.existsSync(dashboardFile)) {
        return res.status(404).send(
            'lms.html was not found. Check your GitHub repository.'
        );
    }

    res.sendFile(dashboardFile);
});

app.use(express.static(__dirname));

// ==========================================
// ERROR HANDLING
// ==========================================
app.use((err, req, res, next) => {
    if (err instanceof SyntaxError && 'body' in err) {
        return res.status(400).json({
            error: 'Invalid JSON request body.'
        });
    }

    next(err);
});

app.use('/api', (req, res) => {
    res.status(404).json({
        error: `API route not found: ${req.method} ${req.originalUrl}`
    });
});

app.use((err, req, res, next) => {
    console.error('Server error:', err);

    if (res.headersSent) return next(err);

    res.status(500).json({
        error: 'Internal server error.'
    });
});

// ==========================================
// INITIAL DATABASE SETUP
// ==========================================
async function initializeDatabase() {
    const books = db.collection(COLLECTIONS.books);
    const members = db.collection(COLLECTIONS.members);
    const users = db.collection(COLLECTIONS.users);

    // Ensure account emails cannot be duplicated.
    await users.createIndex({ email: 1 }, { unique: true });

    // Seed the example book only when the collection is empty.
    if (await books.countDocuments() === 0) {
        await books.insertOne({
            bookId: '101',
            title: 'The Great King',
            author: 'Luther',
            isbn: 'LB-101',
            genre: 'Classic Fiction',
            totalCopies: 5,
            availableCopies: 5,
            shelf: 'A-01'
        });
    }

    // Seed the example member only when the collection is empty.
    if (await members.countDocuments() === 0) {
        await members.insertOne({
            id: 'M-001',
            name: 'Juan Dela Cruz',
            email: 'juan@example.com',
            status: 'Active',
            fineBalance: 0
        });
    }

    // Initialize counters from existing database IDs.
    const allBooks = await books.find(
        {}, { projection: { bookId: 1 } }
    ).toArray();

    const maxBookId = allBooks.reduce((max, book) => {
        const id = Number(book.bookId);
        return Number.isInteger(id) ? Math.max(max, id) : max;
    }, 100);

    await db.collection(COLLECTIONS.counters).updateOne(
        { _id: 'bookId' },
        { $max: { seq: maxBookId } },
        { upsert: true }
    );

    const allMembers = await members.find(
        {}, { projection: { id: 1 } }
    ).toArray();

    const maxMemberId = allMembers.reduce((max, member) => {
        const match = String(member.id).match(/^M-(\d+)$/);
        return match ? Math.max(max, Number(match[1])) : max;
    }, 0);

    await db.collection(COLLECTIONS.counters).updateOne(
        { _id: 'memberId' },
        { $max: { seq: maxMemberId } },
        { upsert: true }
    );

    const allLoans = await db.collection(COLLECTIONS.loans).find(
        {}, { projection: { id: 1 } }
    ).toArray();

    const maxLoanId = allLoans.reduce((max, loan) => {
        const id = Number(loan.id);
        return Number.isInteger(id) ? Math.max(max, id) : max;
    }, 0);

    await db.collection(COLLECTIONS.counters).updateOne(
        { _id: 'loanId' },
        { $max: { seq: maxLoanId } },
        { upsert: true }
    );

    console.log('MongoDB collections initialized.');
}

// ==========================================
// CONNECT TO ATLAS AND START SERVER
// ==========================================
async function startServer() {
    const mongoURI = process.env.MONGODB_URI;

    if (mongoURI) {
        try {
            mongoClient = new MongoClient(mongoURI, {
                serverSelectionTimeoutMS: 10000
            });

            await mongoClient.connect();

            db = mongoClient.db('lms');
            await db.command({ ping: 1 });
            await initializeDatabase();

            mongoConnected = true;

            console.log('MongoDB Atlas connected successfully.');
            console.log('Database selected: lms');
        } catch (error) {
            mongoConnected = false;
            db = null;

            console.error('MongoDB connection failed:', error.message);

            if (mongoClient) {
                await mongoClient.close().catch(() => {});
                mongoClient = null;
            }
        }
    } else {
        console.error('MONGODB_URI is missing from the environment.');
    }

    app.listen(PORT, () => {
        console.log(`ARCHIVE LMS running on port ${PORT}`);
        console.log('Health check: /api/health');
    });
}

startServer();
