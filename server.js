
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { MongoClient } = require('mongodb');

const app = express();
const PORT = process.env.PORT || 3000;

// ==========================================
// MONGODB ATLAS
// ==========================================
let mongoClient = null;
let db = null;
let mongoConnected = false;
let mongoConnecting = false;

// ==========================================
// MIDDLEWARE
// ==========================================
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// ==========================================
// TEMPORARY IN-MEMORY STORAGE
// Existing APIs still use these arrays.
// Database persistence is not yet implemented.
// ==========================================
let books = [
    {
        bookId: '101',
        title: 'The Great King',
        author: 'Luther',
        isbn: 'LB-101',
        genre: 'Classic Fiction',
        totalCopies: 5,
        availableCopies: 5,
        shelf: 'A-01'
    }
];

let members = [
    {
        id: 'M-001',
        name: 'Juan Dela Cruz',
        email: 'juan@example.com',
        status: 'Active',
        fineBalance: 0
    }
];

let loans = [];
let users = [];

let nextBookId = 102;
let nextMemberId = 2;
let nextLoanId = 1;

// ==========================================
// HELPER FUNCTIONS
// ==========================================
function today() {
    return new Date().toISOString().slice(0, 10);
}

function isNonEmptyString(value) {
    return typeof value === 'string' &&
        value.trim().length > 0;
}

function findBook(id) {
    return books.find(
        book => String(book.bookId ?? book.id) === String(id)
    );
}

function findMember(id) {
    return members.find(
        member => String(member.id ?? member.memberId) === String(id)
    );
}

function findLoan(id) {
    return loans.find(
        loan => String(loan.id) === String(id)
    );
}

function getLoanResponse(loan) {
    const isOverdue =
        loan.status === 'Active' &&
        loan.dueDate < today();

    return {
        ...loan,
        status: loan.status === 'Returned'
            ? 'Returned'
            : isOverdue
                ? 'Overdue'
                : 'Active'
    };
}

function validateBook(body, existingBook = null) {
    const { title, author, isbn } = body;

    if (!isNonEmptyString(title)) {
        return 'Book title is required.';
    }

    if (!isNonEmptyString(author)) {
        return 'Author is required.';
    }

    const totalCopies = Number(
        body.totalCopies ?? existingBook?.totalCopies ?? 1
    );

    if (!Number.isInteger(totalCopies) || totalCopies < 1) {
        return 'Total copies must be a positive whole number.';
    }

    const duplicateISBN = isbn
        ? books.find(book =>
            String(book.isbn).toLowerCase() ===
                String(isbn).trim().toLowerCase() &&
            String(book.bookId ?? book.id) !==
                String(existingBook?.bookId ?? existingBook?.id)
        )
        : null;

    if (duplicateISBN) {
        return 'A book with this ISBN already exists.';
    }

    return null;
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
app.get('/api/books', (req, res) => {
    res.json(books);
});

// GET one book
app.get('/api/books/:id', (req, res) => {
    const book = findBook(req.params.id);

    if (!book) {
        return res.status(404).json({
            error: 'Book not found.'
        });
    }

    res.json(book);
});

// ADD a book
app.post('/api/books', (req, res) => {
    const error = validateBook(req.body);

    if (error) {
        return res.status(400).json({ error });
    }

    const totalCopies = Number(req.body.totalCopies ?? 1);

    const book = {
        bookId: String(nextBookId++),
        title: req.body.title.trim(),
        author: req.body.author.trim(),
        isbn: String(req.body.isbn ?? '').trim(),
        genre: String(
            req.body.genre ?? 'Uncategorized'
        ).trim(),
        totalCopies,
        availableCopies: totalCopies,
        shelf: String(req.body.shelf ?? '').trim()
    };

    books.push(book);

    res.status(201).json({
        message: 'Book added successfully.',
        book
    });
});

// EDIT an existing book
app.put('/api/books/:id', (req, res) => {
    const book = findBook(req.params.id);

    if (!book) {
        return res.status(404).json({
            error: 'Book not found.'
        });
    }

    const error = validateBook(req.body, book);

    if (error) {
        return res.status(400).json({ error });
    }

    const checkedOut = loans.filter(loan =>
        loan.bookId === String(book.bookId) &&
        loan.status === 'Active'
    ).length;

    const totalCopies = Number(
        req.body.totalCopies ?? book.totalCopies
    );

    if (totalCopies < checkedOut) {
        return res.status(400).json({
            error: `At least ${checkedOut} total copies are required because those copies are on loan.`
        });
    }

    book.title = req.body.title.trim();
    book.author = req.body.author.trim();
    book.isbn = String(req.body.isbn ?? '').trim();
    book.genre = String(
        req.body.genre ?? book.genre
    ).trim();
    book.shelf = String(
        req.body.shelf ?? book.shelf
    ).trim();
    book.totalCopies = totalCopies;
    book.availableCopies = totalCopies - checkedOut;

    res.json({
        message: 'Book updated successfully.',
        book
    });
});

// ==========================================
// MEMBERS API
// ==========================================

// GET all members
app.get('/api/members', (req, res) => {
    res.json(members);
});

// GET one member
app.get('/api/members/:id', (req, res) => {
    const member = findMember(req.params.id);

    if (!member) {
        return res.status(404).json({
            error: 'Member not found.'
        });
    }

    res.json(member);
});

// REGISTER a member
app.post('/api/members', (req, res) => {
    const { name, email } = req.body;

    if (!isNonEmptyString(name)) {
        return res.status(400).json({
            error: 'Member name is required.'
        });
    }

    if (!isNonEmptyString(email)) {
        return res.status(400).json({
            error: 'Member email is required.'
        });
    }

    const normalizedEmail = email.trim().toLowerCase();

    const duplicate = members.some(member =>
        String(member.email).toLowerCase() === normalizedEmail
    );

    if (duplicate) {
        return res.status(409).json({
            error: 'A member with this email already exists.'
        });
    }

    const member = {
        id: `M-${String(nextMemberId++).padStart(3, '0')}`,
        name: name.trim(),
        email: normalizedEmail,
        status: 'Active',
        fineBalance: 0
    };

    members.push(member);

    res.status(201).json({
        message: 'Member registered successfully.',
        member
    });
});

// ==========================================
// LOANS API
// ==========================================

// GET all loans
app.get('/api/loans', (req, res) => {
    res.json(loans.map(getLoanResponse));
});

// GET one loan
app.get('/api/loans/:id', (req, res) => {
    const loan = findLoan(req.params.id);

    if (!loan) {
        return res.status(404).json({
            error: 'Loan not found.'
        });
    }

    res.json(getLoanResponse(loan));
});

// CREATE a loan / borrow a book
app.post('/api/loans', (req, res) => {
    const {
        memberId,
        bookId,
        borrowDate,
        dueDate
    } = req.body;

    if (!memberId || !bookId || !borrowDate || !dueDate) {
        return res.status(400).json({
            error: 'Member, book, borrow date, and due date are required.'
        });
    }

    if (
        !/^\d{4}-\d{2}-\d{2}$/.test(borrowDate) ||
        !/^\d{4}-\d{2}-\d{2}$/.test(dueDate) ||
        Number.isNaN(Date.parse(borrowDate)) ||
        Number.isNaN(Date.parse(dueDate))
    ) {
        return res.status(400).json({
            error: 'Dates must use YYYY-MM-DD format.'
        });
    }

    if (dueDate < borrowDate) {
        return res.status(400).json({
            error: 'Due date cannot be before the borrow date.'
        });
    }

    const member = findMember(memberId);
    const book = findBook(bookId);

    if (!member) {
        return res.status(404).json({
            error: 'Member not found.'
        });
    }

    if (member.status !== 'Active') {
        return res.status(400).json({
            error: 'This member is not active.'
        });
    }

    if (!book) {
        return res.status(404).json({
            error: 'Book not found.'
        });
    }

    if (Number(book.availableCopies) < 1) {
        return res.status(400).json({
            error: 'No available copies for this book.'
        });
    }

    const loan = {
        id: String(nextLoanId++),
        memberId: String(member.id),
        memberName: member.name,
        bookId: String(book.bookId ?? book.id),
        bookTitle: book.title,
        borrowDate,
        dueDate,
        returnDate: null,
        status: 'Active'
    };

    book.availableCopies = Number(book.availableCopies) - 1;
    loans.push(loan);

    res.status(201).json({
        message: 'Loan created successfully.',
        loan: getLoanResponse(loan)
    });
});

// RETURN a borrowed book
app.patch('/api/loans/:id/return', (req, res) => {
    const loan = findLoan(req.params.id);

    if (!loan) {
        return res.status(404).json({
            error: 'Loan not found.'
        });
    }

    if (loan.status === 'Returned') {
        return res.status(400).json({
            error: 'This book has already been returned.'
        });
    }

    const book = findBook(loan.bookId);

    if (!book) {
        return res.status(404).json({
            error: 'Associated book not found.'
        });
    }

    const returnDate = req.body?.returnDate || today();

    if (
        !/^\d{4}-\d{2}-\d{2}$/.test(returnDate) ||
        Number.isNaN(Date.parse(returnDate))
    ) {
        return res.status(400).json({
            error: 'Return date must use YYYY-MM-DD format.'
        });
    }

    loan.returnDate = returnDate;
    loan.status = 'Returned';

    book.availableCopies = Math.min(
        Number(book.totalCopies),
        Number(book.availableCopies) + 1
    );

    res.json({
        message: 'Book returned successfully.',
        loan: getLoanResponse(loan)
    });
});

// ==========================================
// AUTHENTICATION API
// PROTOTYPE ONLY: passwords are NOT hashed.
// Users are stored in memory and reset on restart.
// ==========================================

// REGISTER
app.post('/api/register', (req, res) => {
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

    const existingUser = users.find(
        user => user.email === normalizedEmail
    );

    if (existingUser) {
        return res.status(409).json({
            error: 'Email is already registered.'
        });
    }

    const allowedRoles = ['Main Librarian', 'Librarian'];
    const safeRole = allowedRoles.includes(role)
        ? role
        : 'Librarian';

    const newUser = {
        name: name.trim(),
        role: safeRole,
        email: normalizedEmail,
        password
    };

    users.push(newUser);

    res.status(201).json({
        message: 'Account created successfully.',
        user: {
            name: newUser.name,
            role: newUser.role,
            email: newUser.email
        }
    });
});

// LOGIN
app.post('/api/login', (req, res) => {
    const { email, password } = req.body;

    if (!isNonEmptyString(email) || !isNonEmptyString(password)) {
        return res.status(400).json({
            error: 'Email and password are required.'
        });
    }

    const normalizedEmail = email.trim().toLowerCase();

    const user = users.find(
        user =>
            user.email === normalizedEmail &&
            user.password === password
    );

    if (!user) {
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
});

// ==========================================
// FRONTEND ROUTING
// ==========================================
const loginFile = path.join(__dirname, 'login.html');
const dashboardFile = path.join(__dirname, 'lms.html');

app.get('/', (req, res) => {
    if (!fs.existsSync(loginFile)) {
        return res.status(500).send(
            'login.html was not found in the deployed server directory.'
        );
    }

    res.sendFile(loginFile);
});

app.get('/login.html', (req, res) => {
    if (!fs.existsSync(loginFile)) {
        return res.status(404).send(
            'login.html was not found in the deployed server directory.'
        );
    }

    res.sendFile(loginFile);
});

app.get('/lms.html', (req, res) => {
    if (!fs.existsSync(dashboardFile)) {
        return res.status(404).send(
            'lms.html was not found in the deployed server directory. Check that the file is committed to GitHub and included in the Render deployment.'
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

    if (res.headersSent) {
        return next(err);
    }

    res.status(500).json({
        error: 'Internal server error.'
    });
});

// ==========================================
// START SERVER
// Start HTTP server even if Atlas is unavailable.
// ==========================================
app.listen(PORT, () => {
    console.log(`ARCHIVE LMS running on port ${PORT}`);
    console.log('Health check: /api/health');
});

// ==========================================
// CONNECT TO MONGODB IN BACKGROUND
// ==========================================
async function connectMongoDB() {
    if (mongoConnecting || mongoConnected) {
        return;
    }

    const mongoURI = process.env.MONGODB_URI;

    if (!mongoURI) {
        console.error(
            'MongoDB not connected: MONGODB_URI is missing from Render Environment.'
        );
        return;
    }

    mongoConnecting = true;

    try {
        mongoClient = new MongoClient(mongoURI, {
            serverSelectionTimeoutMS: 10000
        });

        await mongoClient.connect();

        const database = mongoClient.db('lms');
        await database.command({ ping: 1 });

        db = database;
        mongoConnected = true;

        console.log('MongoDB Atlas connected successfully.');
        console.log('Database selected: lms');
    } catch (error) {
        mongoConnected = false;
        db = null;

        console.error(
            'MongoDB connection failed:',
            error.message
        );

        if (mongoClient) {
            await mongoClient.close().catch(() => {});
            mongoClient = null;
        }
    } finally {
        mongoConnecting = false;
    }
}

connectMongoDB();
