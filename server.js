const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();

// Middleware
app.use(express.json());
app.use(cors());


app.use(express.static(path.join(__dirname)));

// ==========================================
// MGA API ROUTES (Books & Members)
// ==========================================
let books = [
    { bookId: "101", title: "The Great King", author: "Luther", isbn: "LB-101", genre: "Classic Fiction", totalCopies: 5, availableCopies: 5, shelf: "A-01" }
];

let members = [
    { id: "M-001", name: "Juan Dela Cruz", email: "juan@example.com", status: "Active", fineBalance: 0.00 }
];

// GET: 
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
// AUTHENTICATION API ROUTES (Login & Register)
// ==========================================
let users = []; // Temporary user storage

// POST: Register 
app.post('/api/register', (req, res) => {
    const { name, role, email, password } = req.body;
    
    // Check kung may existing user na
    const existingUser = users.find(u => u.email === email);
    if (existingUser) {
        return res.status(400).json({ error: 'Email is already registered.' });
    }

    const newUser = { name, role, email, password };
    users.push(newUser);
    res.status(201).json({ message: "Account created successfully!", user: { name, role, email } });
});

// POST: Login user
app.post('/api/login', (req, res) => {
    const { email, password } = req.body;
    
    const user = users.find(u => u.email === email && u.password === password);
    if (!user) {
        return res.status(400).json({ error: 'Invalid email address or password.' });
    }

    res.json({ message: "Login successful!", user: { name: user.name, role: user.role, email: user.email } });
});

// ==========================================
// ROOT ROUTING 
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
