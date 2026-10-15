const balance = document.getElementById('balance');
const list = document.getElementById('list');
const description = document.getElementById('description');
const amount = document.getElementById('amount');
const btnIncome = document.getElementById('add-income');
const btnExpense = document.getElementById('add-expense');
const historySection = document.getElementById('history-section');

let transactions = [];

// Generate random ID
function generateID() {
    return Math.floor(Math.random() * 100000000);
}

// Add transaction
function addTransaction(e, type) {
    e.preventDefault();

    if (description.value.trim() === '' || amount.value.trim() === '') {
        alert('Please add a description and amount');
        return;
    }

    const value = parseFloat(amount.value);
    
    if (isNaN(value) || value <= 0) {
        alert('Please enter a valid positive amount');
        return;
    }

    const transaction = {
        id: generateID(),
        text: description.value,
        amount: type === 'income' ? value : -value
    };

    transactions.push(transaction);

    addTransactionDOM(transaction);
    updateValues();

    description.value = '';
    amount.value = '';
}

// Add transactions to DOM
function addTransactionDOM(transaction) {
    const isExpense = transaction.amount < 0;
    const sign = isExpense ? '-' : '+';
    const typeLabel = isExpense ? 'Expense' : 'Income';
    const item = document.createElement('li');

    // Add class based on value
    item.classList.add(isExpense ? 'expense' : 'income');

    item.innerHTML = `
        <div class="info">
            <span class="desc">${transaction.text}</span>
            <span class="type-badge">${typeLabel}</span>
        </div>
        <span class="amt">${sign}$${Math.abs(transaction.amount).toFixed(2)}</span>
        <button class="delete-btn" onclick="removeTransaction(${transaction.id})">&times;</button>
    `;

    list.appendChild(item);
}

// Update the balance and UI visibility
function updateValues() {
    const amounts = transactions.map(transaction => transaction.amount);
    const total = amounts.reduce((acc, item) => (acc += item), 0).toFixed(2);
    
    const sign = total < 0 ? '-' : '';
    // Prevent -0.00 rendering
    const formattedTotal = total === "-0.00" ? "0.00" : Math.abs(total).toFixed(2);
    
    balance.innerText = `${sign}$${formattedTotal}`;

    // Show/hide history section based on transactions array
    if (transactions.length > 0) {
        historySection.style.display = 'block';
    } else {
        historySection.style.display = 'none';
    }
}

// Remove transaction by ID
function removeTransaction(id) {
    transactions = transactions.filter(transaction => transaction.id !== id);
    init();
}

// Init app
function init() {
    list.innerHTML = '';
    transactions.forEach(addTransactionDOM);
    updateValues();
}

btnIncome.addEventListener('click', (e) => addTransaction(e, 'income'));
btnExpense.addEventListener('click', (e) => addTransaction(e, 'expense'));

init();
