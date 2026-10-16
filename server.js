const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();

// Middleware para sa JSON at CORS
app.use(express.json());
app.use(cors());

// Mag-serve ng static files (tulad ng login.html, lms.html, etc.) galing sa current folder
app.use(express.static(path.join(__dirname)));

// ==========================================
// MGA API ROUTES
// ==========================================

// Temporary storage (Pwede mong palitan ng database tulad ng Supabase o MS Access connection dito)
let books = [
    { bookId: "101", title: "The Great King", author: "Luther", isbn: "LB-101", genre: "Classic Fiction", totalCopies: 5, availableCopies: 5, shelf: "A-01" }
];

let members = [
    { id: "M-001", name: "Juan Dela Cruz", email: "juan@example.com", status: "Active", fineBalance: 0.00 }
];

// GET: Kunin ang listahan ng mga libro
app.get('/api/books', (req, res) => {
    res.json(books);
});

// POST: Magdagdag ng bagong libro
app.post('/api/books', (req, res) => {
    const newBook = req.body;
    books.push(newBook);
    res.status(201).json({ message: "Book added successfully!", book: newBook });
});

// GET: Kunin ang listahan ng mga members
app.get('/api/members', (req, res) => {
    res.json(members);
});

// POST: Mag-rehistro ng bagong member
app.post('/api/members', (req, res) => {
    const newMember = req.body;
    members.push(newMember);
    res.status(201).json({ message: "Member registered successfully!", member: newMember });
});

// ==========================================
// ROOT ROUTING PARA SA LOGIN
// ==========================================
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'login.html'));
});

// ==========================================
// SERVER PORT CONFIGURATION (Cloud & Local Ready)
// ==========================================
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`LMS Server is running and active on port ${PORT}`);
});