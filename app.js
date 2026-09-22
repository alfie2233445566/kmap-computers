// Kmap Computers Application Engine
let storage = {};

// Queue for uploading to Vercel KV
window.kvSyncQueue = {};
window.kvSyncTimeout = null;

const triggerKVSync = () => {
    if (Object.keys(window.kvSyncQueue).length === 0) return;
    
    const payload = { updates: { ...window.kvSyncQueue } };
    window.kvSyncQueue = {}; // Clear queue
    
    fetch('/api/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    }).catch(err => console.error('KV Sync Error:', err));
};

const safeLocalStorage = {
    getItem: (key) => {
        try {
            return window.localStorage.getItem(key);
        } catch (e) {
            return storage[key] || null;
        }
    },
    setItem: (key, val, skipSync = false) => {
        try {
            window.localStorage.setItem(key, val);
        } catch (e) {
            storage[key] = String(val);
        }
        
        // Push to cloud if it's a watched key and sync is not skipped
        const watchedKeys = ['kmap_products', 'kmap_users', 'kmap_orders', 'kmap_logs', 'kmap_promos', 'kmap_hire_purchase'];
        if (!skipSync && watchedKeys.includes(key)) {
            try {
                window.kvSyncQueue[key] = JSON.parse(val);
                if (window.kvSyncTimeout) clearTimeout(window.kvSyncTimeout);
                window.kvSyncTimeout = setTimeout(triggerKVSync, 1000); // Debounce uploads
            } catch(e) {}
        }
    },
    removeItem: (key) => {
        try {
            window.localStorage.removeItem(key);
        } catch (e) {
            delete storage[key];
        }
    }
};

class KmapStoreApp {
    constructor() {
        this.db = null;
        this.currentUser = null;
        this.activeView = 'client-store';
        this.activeCategory = 'All';
        this.cart = [];
        this.salesChart = null;
        this.inspectBackView = null;
        
        // History Navigation
        this.viewHistory = [];
        this.viewHistoryPointer = -1;
        this.isNavigatingHistory = false;
        
        this.initDatabase();
        this.bindEvents();
        this.initSession();
        
        // Start polling for Vercel KV updates
        setInterval(() => this.syncDownstream(), 5000);
        this.syncDownstream();
    }

    async syncDownstream() {
        try {
            const res = await fetch('/api/sync');
            if (res.ok) {
                const data = await res.json();
                let updated = false;
                for (const key of Object.keys(data)) {
                    if (data[key]) {
                        const cloudVal = JSON.stringify(data[key]);
                        const localVal = window.localStorage.getItem(key);
                        if (cloudVal !== localVal) {
                            // Update silently to prevent triggering push
                            safeLocalStorage.setItem(key, cloudVal, true);
                            updated = true;
                        }
                    }
                }
                if (updated) {
                    // Trigger cross-tab sync to refresh UI instantly
                    window.dispatchEvent(new StorageEvent('storage', { key: 'kmap_orders' }));
                    window.dispatchEvent(new StorageEvent('storage', { key: 'kmap_products' }));
                }
            }
        } catch(e) {
            // Silently fail if offline or API down
        }
    }

    initSession() {
        const savedUser = safeLocalStorage.getItem('kmap_current_user');
        if (savedUser) {
            this.currentUser = JSON.parse(savedUser);
            document.getElementById('login-screen').style.display = 'none';
            document.getElementById('app-root').style.display = 'flex';
            this.updateProfileHeader(this.currentUser);
            this.renderSidebar();
            this.loadCart();
            if (this.currentUser.role === 'client' || this.currentUser.role === 'guest') {
                this.switchView('client-store');
            } else {
                this.switchView('admin-dashboard');
            }
        }
    }

    saveCart() {
        if (this.currentUser && this.currentUser.username !== 'guest') {
            safeLocalStorage.setItem(`kmap_cart_${this.currentUser.username}`, JSON.stringify(this.cart));
            const users = this.db.getUsers();
            const user = users.find(u => u.username === this.currentUser.username);
            if (user) {
                user.cart = [...this.cart];
                this.db.saveUsers(users);
                this.currentUser.cart = [...this.cart];
                if (safeLocalStorage.getItem('kmap_current_user')) {
                    safeLocalStorage.setItem('kmap_current_user', JSON.stringify(this.currentUser));
                }
            }
        }
    }

    loadCart() {
        if (this.currentUser && this.currentUser.username !== 'guest') {
            const users = this.db.getUsers();
            const user = users.find(u => u.username === this.currentUser.username);
            if (user && user.cart) {
                this.cart = [...user.cart];
            } else {
                const saved = safeLocalStorage.getItem(`kmap_cart_${this.currentUser.username}`);
                this.cart = saved ? JSON.parse(saved) : [];
            }
        } else {
            this.cart = [];
        }
        this.renderCart();
    }

    updateProfileHeader(user) {
        document.getElementById('profile-name').innerText = user.name;
        document.getElementById('profile-avatar').innerText = user.name.charAt(0);
    }

    // Initialize mock database in localStorage
    initDatabase() {
        const defaultProducts = [
            {
                id: 'PROD-001',
                name: 'Hp Zbook 15u G6',
                category: 'Laptops',
                price: 7000,
                stock: 10,
                spec: 'Intel Core i7, 8th Generation, 32GB Memory, 1TB Solid state Drive, 8CPUs @ 1.8Ghz Speed, AMD Radeon RX Graphics *4GB Dedicated Graphics*, Fingerprint Security, 2Type C USB Slots, Hdmi & USB Slots, 15.6 inch Screen Size, Strong Battery',
                icon: '💻',
                images: []
            },
            {
                id: 'PROD-002',
                name: 'HP Probook x360 435 G7',
                category: 'Laptops',
                price: 4800,
                stock: 10,
                spec: 'AMD Ryzen 7 PRO, 16GB Memory, 256GB Solid state Drive, 8CPUs @ 1.9Ghz Speed, AMD Radeon RX Graphics *Dedicated Graphics*, Fingerprint Security, HD camera, Touchscreen, 2Type C USB Slots, Hdmi & USB Slots, 14.0 inch Screen Size, Strong Battery, Hdmi & USB Slots, 15.6 inch Screen Size, Strong Battery',
                icon: '💻',
                images: []
            },
            {
                id: 'PROD-003',
                name: 'Hp Probook 640 G5',
                category: 'Laptops',
                price: 3200,
                stock: 10,
                spec: 'Intel Core i5, 8th Generation, 8gb Memory, 256gb Solid state Drive, 4CPUs @ 1.6Ghz Speed, Fingerprint Security, Backlit Keyboard, 1Type C USB Slots, Hdmi & USB Slots, 14.0 inch Screen Size, Strong Battery',
                icon: '💻',
                images: []
            },
            {
                id: 'PROD-004',
                name: 'Hp Probook 430 G7',
                category: 'Laptops',
                price: 4800,
                stock: 10,
                spec: 'Intel Core i5, 10th Generation, 16gb Memory, 256gb Solid state Drive, 4CPUs @ 1.6Ghz Speed, Fingerprint Security, Backlit Keyboard, 1Type C USB Slots, Hdmi & USB Slots, 14.0 inch Screen Size, Strong Battery',
                icon: '💻',
                images: []
            },
            {
                id: 'PROD-005',
                name: 'Dell Latitude 5270',
                category: 'Laptops',
                price: 2600,
                stock: 10,
                spec: 'Intel Core i5, 6th Generation, 8gb Memory, 256GB Solid state Drive, 8CPUs @ 2.40 Ghz Speed, Hdmi & USB Slots, 14.0 inch Screen Size, Strong Battery',
                icon: '💻',
                images: []
            },
            {
                id: 'PROD-006',
                name: 'Dell Latitude 5450',
                category: 'Laptops',
                price: 1950,
                stock: 10,
                spec: 'Intel Core i5, 5th Generation, 8gb Memory, 500GB HDD, 8CPUs @ 2.30Ghz Speed, Hdmi & USB Slots, 14.0 inch Screen Size, Strong Battery',
                icon: '💻',
                images: []
            },
            {
                id: 'PROD-007',
                name: 'Dell Latitude 5400',
                category: 'Laptops',
                price: 4600,
                stock: 10,
                spec: 'Intel Core i5, 8th Generation, 16gb Memory, 512gb Solid state Drive, 8CPUs @ 1.60 Ghz Speed, Backlit Keyboard, 2Type C USB Slots, Hdmi & USB Slots, 14.0 inch Screen Size, Strong Battery',
                icon: '💻',
                images: []
            },
            {
                id: 'PROD-008',
                name: 'Dell Latitude 5500',
                category: 'Laptops',
                price: 4200,
                stock: 10,
                spec: 'Intel Core i5, 8th Generation, 8gb Memory, 256gb Solid state Drive, 8CPUs @ 1.60 Ghz Speed, Backlit Keyboard, 1Type C USB Slots, Hdmi & USB Slots, 15.6 inch Screen Size, Strong Battery',
                icon: '💻',
                images: []
            },
            {
                id: 'PROD-009',
                name: 'Dell Latitude 7320',
                category: 'Laptops',
                price: 6000,
                stock: 10,
                spec: 'Intel Core i7, 11th Generation, 16gb Memory, 512gb Solid state Drive, 8CPUs @ 3.0Ghz Speed, Fingerprint Security, Backlit Keyboard, 2Type C USB Slots, Hdmi & USB Slots, 13.3inch Screen Size, Strong Battery',
                icon: '💻',
                images: []
            },
            {
                id: 'PROD-010',
                name: 'Hp Elitebook 840 G7',
                category: 'Laptops',
                price: 5000,
                stock: 10,
                spec: 'Intel Core i5, 10th Generation, 8GB Memory, 256gb Solid state Drive, 8CPUs @ 1.7Ghz Speed, Fingerprint Security, 2Type C USB Slots, Hdmi & USB Slots, 14.0 inch Screen Size, Strong Battery',
                icon: '💻',
                images: []
            },
            {
                id: 'PROD-011',
                name: 'Hp EliteBook 1040 G7',
                category: 'Laptops',
                price: 6000,
                stock: 10,
                spec: 'Core i5 10th Generation, 16gbMemory, 256gb Solid state Drive, 8CPUs @ 1.7Ghz Speed, x360 Convertible, Touchscreen Display, Face iD Recognition, Fingerprint Security, Backlit Keyboard, 2Type C Slots, Hdmi & USB Slots, 14.0 inch Screen Size, Strong Battery',
                icon: '💻',
                images: []
            },
            {
                id: 'PROD-012',
                name: 'Hp EliteBook 1030 G2',
                category: 'Laptops',
                price: 4000,
                stock: 10,
                spec: 'Intel Core i5, 7th Generation, 8gb Memory, 256gb Solid state Drive, 4CPUs @ 2.6Ghz Speed, x360 Convertible, Touchscreen Display, Face iD Recognition, Fingerprint Security, Backlit Keyboard, 1Type C USB Slots, Hdmi & USB Slots, 14.0 inch Screen Size, Strong Battery',
                icon: '💻',
                images: []
            },
            {
                id: 'PROD-013',
                name: 'Hp EliteBook 840 G5',
                category: 'Laptops',
                price: 3000,
                stock: 10,
                spec: 'Intel Core i5, 7th Generation, 8gb Memory, 256gb Solid state Drive, 4CPUs @ 2.6Ghz Speed, Fingerprint Security, Backlit Keyboard, 1Type C USB Slots, Hdmi & USB Slots, 14.0 inch Screen Size, Strong Battery',
                icon: '💻',
                images: []
            },
            {
                id: 'PROD-014',
                name: 'Hp EliteBook 830 G6',
                category: 'Laptops',
                price: 4800,
                stock: 10,
                spec: 'Intel Core i5, 8th Generation, 16gb Memory, 256gb Solid state Drive, 4CPUs @ 1.6Ghz Speed, x360 Convertible, Fingerprint Security, Backlit Keyboard, 1Type C USB Slots, Hdmi & USB Slots, 14.0 inch Screen Size, Strong Battery',
                icon: '💻',
                images: []
            },
            {
                id: 'PROD-015',
                name: 'Hp EliteBook 840 G3',
                category: 'Laptops',
                price: 2500,
                stock: 10,
                spec: 'Intel Core i5, 6th Generation, 8gb Memory, 256gb Solid state Drive, 4CPUs @ 2.4Ghz Speed, Fingerprint Security, Backlit Keyboard, 1Type C USB Slot, Display port & USB Slots, 14.0 inch Screen Size, Strong Battery',
                icon: '💻',
                images: []
            },
            {
                id: 'PROD-016',
                name: 'Dell Latitude 5320',
                category: 'Laptops',
                price: 6500,
                stock: 10,
                spec: 'Intel Core i7, 11th Generation, 16gb Memory, 512gb Solid state Drive, 8CPUs @ 3.0Ghz Speed, 360 Convertible, Fingerprint Security, Backlit Keyboard, 2Type C USB Slots, Hdmi & USB Slots, 13.3inch Screen Size, Strong Battery',
                icon: '💻',
                images: []
            },
            {
                id: 'PROD-017',
                name: 'Hp Elitebook x360 1040 G5',
                category: 'Laptops',
                price: 4800,
                stock: 10,
                spec: 'Intel Core i5, 8th Generation, 8GB Memory, 256gb Solid state Drive, 8CPUs @ 1.7Ghz Speed, Fingerprint Security, 2Type C USB Slots, Hdmi & USB Slots, 14.0 inch Screen Size, Strong Battery',
                icon: '💻',
                images: []
            },
            {
                id: 'PROD-018',
                name: 'Hp Spectre Pro x360 G2',
                category: 'Laptops',
                price: 3500,
                stock: 10,
                spec: 'Intel Core i5, 6th Generation, 8gb Memory, 256gb Solid state Drive, 4CPUs @ 2.4Ghz Speed, x360 Convertible, Touchscreen Display, Backlit Keyboard, Hdmi & USB Slots, 14.0 inch Screen Size, Strong Battery',
                icon: '💻',
                images: []
            },
            {
                id: 'PROD-019',
                name: 'Dell XPS 13 9360',
                category: 'Laptops',
                price: 3800,
                stock: 10,
                spec: 'Intel Core i5, 7th Generation, 8Gb Memory, 256gb Solid state Drive, 8CPUs @ 2.6Ghz Speed, Fingerprint Security, Backlit Keyboard, Type C USB Slot, USB Slots, 13.3inch Screen Size, Strong Battery',
                icon: '💻',
                images: []
            },
            {
                id: 'PROD-020',
                name: 'Dell latitude 7290',
                category: 'Laptops',
                price: 3000,
                stock: 10,
                spec: 'Intel Core i5, 7th Generation, 8Gb Memory, 256gb Solid state Drive, 8CPUs @ 2.6Ghz Speed, Backlit Keyboard, Type C USB Slot, USB Slots, 13.3inch Screen Size, Strong Battery',
                icon: '💻',
                images: []
            }
        ];

        const defaultUsers = [
            { username: 'superadmin', role: 'superadmin', name: 'Super Administrator', password: 'super123' },
            { username: 'admin', role: 'admin', name: 'Admin Manager', password: 'admin123' },
            { username: '0241234567', role: 'client', name: 'Kwame Mensah', password: 'client123', phone: '0241234567' }
        ];

        const defaultOrders = [
            { 
                id: 'ORD-8932', 
                clientName: 'Kwame Mensah', 
                phone: '0241234567', 
                items: [{ id: 'PROD-001', name: 'Hp Zbook 15u G6', price: 7000, qty: 1 }], 
                total: 7000, 
                claimMethod: 'delivery', 
                address: 'East Legon, Accra', 
                date: new Date(Date.now() - 3600000 * 24 * 2).toISOString(), // 2 days ago
                status: 'completed' 
            },
            { 
                id: 'ORD-7612', 
                clientName: 'Ama Serwaa', 
                phone: '0247654321', 
                items: [{ id: 'PROD-002', name: 'HP Probook x360 435 G7', price: 4800, qty: 1 }], 
                total: 4800, 
                claimMethod: 'walk_in', 
                address: '', 
                date: new Date(Date.now() - 3600000 * 4).toISOString(), // 4 hours ago
                status: 'pending' 
            }
        ];

        const defaultHP = [
            {
                id: 'HP-001',
                clientName: 'Kwame Mensah',
                phone: '0241234567',
                machine: 'Hp Zbook 15u G6',
                price: 7000,
                deposit: 2500,
                months: 3,
                startDate: new Date(Date.now() - 3600000 * 24 * 28).toISOString(), // 28 days ago
                installments: [
                    { month: 1, dueDate: new Date(Date.now() - 3600000 * 24 * 28 + 3600000 * 24 * 30).toISOString(), amount: 1500, status: 'pending' },
                    { month: 2, dueDate: new Date(Date.now() - 3600000 * 24 * 28 + 3600000 * 24 * 60).toISOString(), amount: 1500, status: 'pending' },
                    { month: 3, dueDate: new Date(Date.now() - 3600000 * 24 * 28 + 3600000 * 24 * 90).toISOString(), amount: 1500, status: 'pending' }
                ],
                status: 'active'
            }
        ];

        // Check if database reset is needed (to migration to these 20 laptops)
        const existingProducts = safeLocalStorage.getItem('kmap_products');
        let needsReset = false;
        if (existingProducts) {
            try {
                const parsed = JSON.parse(existingProducts);
                if (parsed.length === 0 || parsed.some(p => p.id === 'PROD-001' && p.name !== 'Hp Zbook 15u G6') || parsed.some(p => p.category === 'Accessories')) {
                    needsReset = true;
                }
            } catch (e) {
                needsReset = true;
            }
        } else {
            needsReset = true;
        }

        if (needsReset) {
            safeLocalStorage.setItem('kmap_products', JSON.stringify(defaultProducts));
            safeLocalStorage.setItem('kmap_users', JSON.stringify(defaultUsers));
            safeLocalStorage.setItem('kmap_orders', JSON.stringify(defaultOrders));
            safeLocalStorage.setItem('kmap_logs', JSON.stringify([]));
            safeLocalStorage.setItem('kmap_promos', JSON.stringify([]));
            safeLocalStorage.setItem('kmap_hire_purchase', JSON.stringify(defaultHP));
        }

        this.db = {
            getProducts: () => JSON.parse(safeLocalStorage.getItem('kmap_products')),
            saveProducts: (data) => safeLocalStorage.setItem('kmap_products', JSON.stringify(data)),
            getUsers: () => JSON.parse(safeLocalStorage.getItem('kmap_users')),
            saveUsers: (data) => safeLocalStorage.setItem('kmap_users', JSON.stringify(data)),
            getOrders: () => JSON.parse(safeLocalStorage.getItem('kmap_orders')),
            saveOrders: (data) => safeLocalStorage.setItem('kmap_orders', JSON.stringify(data)),
            getLogs: () => JSON.parse(safeLocalStorage.getItem('kmap_logs')),
            addLog: (msg) => {
                const logs = JSON.parse(safeLocalStorage.getItem('kmap_logs')) || [];
                logs.unshift({ date: new Date().toISOString(), user: this.currentUser?.username || 'System', message: msg });
                safeLocalStorage.setItem('kmap_logs', JSON.stringify(logs));
            },
            getPromos: () => JSON.parse(safeLocalStorage.getItem('kmap_promos')) || [],
            savePromos: (data) => safeLocalStorage.setItem('kmap_promos', JSON.stringify(data)),
            getHP: () => JSON.parse(safeLocalStorage.getItem('kmap_hire_purchase')) || [],
            saveHP: (data) => safeLocalStorage.setItem('kmap_hire_purchase', JSON.stringify(data))
        };
    }

    bindEvents() {
        // Handle Unified Login Form
        document.getElementById('login-form').addEventListener('submit', (e) => {
            e.preventDefault();
            const username = document.getElementById('login-username').value.trim();
            const pass = document.getElementById('login-password').value.trim();
            
            const users = this.db.getUsers();
            const foundUser = users.find(u => u.username === username && u.password === pass);

            if (foundUser) {
                this.currentUser = foundUser;
                this.loadCart();
                safeLocalStorage.setItem('kmap_current_user', JSON.stringify(foundUser));
                document.getElementById('login-screen').style.display = 'none';
                document.getElementById('app-root').style.display = 'flex';
                
                // Set Header Profile
                this.updateProfileHeader(foundUser);
                
                this.db.addLog(`User ${username} authenticated successfully.`);
                this.renderSidebar();
                
                if (foundUser.role === 'client') {
                    this.switchView('client-store');
                } else {
                    this.switchView('admin-dashboard');
                }
            } else {
                const err = document.getElementById('login-error-msg');
                err.innerText = "Invalid credentials. Please check details.";
                err.style.display = 'block';
            }
        });

        // Toggle Login / Signup Forms
        document.getElementById('link-show-signup').addEventListener('click', (e) => {
            e.preventDefault();
            document.getElementById('login-form').style.display = 'none';
            document.getElementById('signup-form').style.display = 'block';
            document.getElementById('login-error-msg').style.display = 'none';
        });

        document.getElementById('link-show-login').addEventListener('click', (e) => {
            e.preventDefault();
            document.getElementById('signup-form').style.display = 'none';
            document.getElementById('login-form').style.display = 'block';
            document.getElementById('login-error-msg').style.display = 'none';
        });

        // Handle Signup Form Submit
        document.getElementById('signup-form').addEventListener('submit', (e) => {
            e.preventDefault();
            const name = document.getElementById('signup-name').value.trim();
            const username = document.getElementById('signup-username').value.trim();
            const pass = document.getElementById('signup-password').value.trim();
            
            const users = this.db.getUsers();
            if (users.find(u => u.username === username)) {
                const err = document.getElementById('login-error-msg');
                err.innerText = "Phone number/username is already registered.";
                err.style.display = 'block';
                return;
            }

            const newUser = { username, role: 'client', name, password: pass, phone: username };
            users.push(newUser);
            this.db.saveUsers(users);
            this.db.addLog(`New client account registered: ${username}`);

            // Automatically log in
            this.currentUser = newUser;
            this.loadCart();
            safeLocalStorage.setItem('kmap_current_user', JSON.stringify(newUser));
            document.getElementById('login-screen').style.display = 'none';
            document.getElementById('app-root').style.display = 'flex';
            
            this.updateProfileHeader(newUser);
            
            this.renderSidebar();
            this.switchView('client-store');
            this.showToast(`Welcome, ${name}! Your account has been registered.`);
            document.getElementById('signup-form').reset();
        });

        // Handle Guest Browse Button
        document.getElementById('btn-guest-browse').addEventListener('click', () => {
            const guestUser = { username: 'guest', role: 'guest', name: 'Guest Viewer' };
            this.currentUser = guestUser;
            this.loadCart();
            safeLocalStorage.setItem('kmap_current_user', JSON.stringify(guestUser));
            
            document.getElementById('login-screen').style.display = 'none';
            document.getElementById('app-root').style.display = 'flex';
            
            this.updateProfileHeader(guestUser);
            
            this.renderSidebar();
            this.switchView('client-store');
            this.showToast("Logged in in Guest Mode. You can browse catalog.");
        });

        // Search Input Handlers
        const searchInput = document.getElementById('client-search');
        if (searchInput) searchInput.addEventListener('input', () => this.renderClientCatalog());

        const orderSearchInput = document.getElementById('order-search');
        if (orderSearchInput) orderSearchInput.addEventListener('input', () => this.renderClientOrders());
        
        const claimMethod = document.getElementById('checkout-claim-method');
        if (claimMethod) {
            claimMethod.addEventListener('change', (e) => {
                const deliveryGroup = document.getElementById('delivery-address-group');
                if (deliveryGroup) deliveryGroup.style.display = e.target.value === 'delivery' ? 'block' : 'none';
            });
        }

        // Backup Upload
        document.getElementById('restore-db-file').addEventListener('change', (e) => this.restoreBackup(e.target));
        
        // Swiping gesture recognition for back/forward navigation
        let touchStartX = 0;
        let touchStartY = 0;
        window.addEventListener('touchstart', (e) => {
            touchStartX = e.changedTouches[0].screenX;
            touchStartY = e.changedTouches[0].screenY;
        }, { passive: true });

        window.addEventListener('touchend', (e) => {
            const diffX = e.changedTouches[0].screenX - touchStartX;
            const diffY = e.changedTouches[0].screenY - touchStartY;
            if (Math.abs(diffX) > 80 && Math.abs(diffY) < 50) {
                if (diffX > 0) {
                    this.goBack();
                } else {
                    this.goForward();
                }
            }
        }, { passive: true });

        // Listen to storage changes for actual real-time order notifications and instant cross-tab sync
        window.addEventListener('storage', (e) => {
            if (e.key === 'kmap_orders') {
                try {
                    const oldOrders = JSON.parse(e.oldValue || '[]');
                    const newOrders = JSON.parse(e.newValue || '[]');
                    
                    // Show notification to Admin/Superadmin on new client order
                    if (newOrders.length > oldOrders.length && this.currentUser && ['admin', 'superadmin'].includes(this.currentUser.role)) {
                        const addedOrders = newOrders.filter(no => !oldOrders.some(oo => oo.id === no.id));
                        addedOrders.forEach(o => {
                            this.showToast(`🔔 New Order Received: ${o.id} - GHS ${o.total.toLocaleString()} from ${o.clientName}!`);
                        });
                    }

                    // Show notification when an order is removed (cancelled/reverted)
                    if (newOrders.length < oldOrders.length) {
                        const removedOrders = oldOrders.filter(oo => !newOrders.some(no => no.id === oo.id));
                        removedOrders.forEach(o => {
                            if (this.currentUser && this.currentUser.role === 'client' && o.phone === (this.currentUser.phone || this.currentUser.username)) {
                                this.showToast(`🚨 Your order ${o.id} has been cancelled and reverted.`);
                            } else if (this.currentUser && ['admin', 'superadmin'].includes(this.currentUser.role)) {
                                this.showToast(`🗑️ Order ${o.id} was cancelled/reverted.`);
                            }
                        });
                    }

                    // Show notification to Client when Admin updates order status
                    if (this.currentUser && this.currentUser.role === 'client') {
                        newOrders.forEach(no => {
                            const oldO = oldOrders.find(oo => oo.id === no.id);
                            if (oldO && oldO.status !== no.status && no.phone === (this.currentUser.phone || this.currentUser.username)) {
                                this.showToast(`📦 Order ${no.id} status updated to: ${no.status.toUpperCase()}`);
                            }
                        });
                    }
                    
                    // Refresh views on all tabs instantly
                    this.renderClientOrders();
                    this.renderAdminOrders();
                    this.renderAdminOverview();
                } catch (err) {
                    console.error('Error parsing order updates', err);
                }
            }
            if (e.key === 'kmap_promos' || e.key === 'kmap_products') {
                this.renderClientCatalog();
                this.renderPromotions();
                this.renderCart();
                this.renderAdminInventory();
                this.renderAdminOverview();
            }
        });

        window.addEventListener('resize', () => {
            this.renderSidebar();
        });

        // Staff Creation Form
        document.getElementById('create-staff-form').addEventListener('submit', (e) => {
            e.preventDefault();
            const user = document.getElementById('staff-username').value.trim();
            const role = document.getElementById('staff-role').value;
            const password = document.getElementById('staff-password').value;

            const users = this.db.getUsers();
            if (users.find(u => u.username === user)) {
                this.showToast("Username already exists!", 'error');
                return;
            }

            users.push({ username: user, role, name: user.toUpperCase(), password });
            this.db.saveUsers(users);
            this.db.addLog(`Created new staff user: ${user} with role ${role}`);
            this.showToast(`User ${user} created successfully.`);
            document.getElementById('create-staff-form').reset();
            this.renderStaffList();
        });

        // Promotions Form Submission
        document.getElementById('create-promo-form').addEventListener('submit', (e) => {
            e.preventDefault();
            const scope = document.getElementById('promo-scope').value;
            const category = document.getElementById('promo-category').value;
            const productId = document.getElementById('promo-product').value;
            const type = document.getElementById('promo-type').value;
            const value = document.getElementById('promo-value').value;
            
            this.createPromotion(scope, category, productId, type, value);
            document.getElementById('create-promo-form').reset();
            this.handlePromoScopeChange();
        });

        // Product Form Submission
        document.getElementById('product-details-form').addEventListener('submit', (e) => {
            e.preventDefault();
            const id = document.getElementById('form-product-id').value;
            const name = document.getElementById('form-product-name').value.trim();
            const category = document.getElementById('form-product-category').value;
            const price = parseFloat(document.getElementById('form-product-price').value) || 0;
            const stock = parseInt(document.getElementById('form-product-stock').value) || 0;
            const spec = document.getElementById('form-product-spec').value.trim();
            
            const images = [];
            document.querySelectorAll('.product-img-url').forEach(input => {
                if (input.value.trim()) images.push(input.value.trim());
            });

            const products = this.db.getProducts();
            if (id) {
                // Edit
                const p = products.find(item => item.id === id);
                if (p) {
                    p.name = name;
                    p.category = category;
                    p.price = price;
                    p.stock = stock;
                    p.spec = spec;
                    p.images = images;
                }
                this.db.addLog(`Updated product details for ${name} (${id})`);
                this.showToast(`Product ${name} updated.`);
            } else {
                // Add
                const newId = 'PROD-00' + (products.length + 1);
                products.push({ id: newId, name, category, price, stock, spec, images, icon: category === 'Laptops' ? '💻' : '🔌' });
                this.db.addLog(`Created new product: ${name} (${newId})`);
                this.showToast(`Product ${name} added.`);
            }
            this.db.saveProducts(products);
            this.closeProductModal();
            this.renderAdminInventory();
        });

        // Enhanced image compression & live preview handler
        const fileInput = document.getElementById('form-product-file-upload');
        if (fileInput) {
            fileInput.addEventListener('change', async (e) => {
                const files = Array.from(e.target.files);
                if (files.length === 0) return;

                const statusEl = document.getElementById('img-upload-status');
                if (statusEl) statusEl.innerText = `Processing ${files.length} photo(s)...`;

                const urlInputs = Array.from(document.querySelectorAll('.product-img-url'));

                for (const file of files) {
                    try {
                        const base64 = await this.compressImageFile(file);
                        const emptyInput = urlInputs.find(input => !input.value.trim());
                        if (emptyInput) {
                            emptyInput.value = base64;
                        } else {
                            // If all 6 inputs filled, replace the last one
                            urlInputs[urlInputs.length - 1].value = base64;
                        }
                    } catch (err) {
                        console.error('Image processing failed:', err);
                    }
                }

                if (statusEl) {
                    statusEl.innerText = '✓ Ready to save!';
                    setTimeout(() => { if (statusEl) statusEl.innerText = ''; }, 3000);
                }

                this.refreshModalImagePreviews();
                // Reset file input so re-selecting same file triggers change
                fileInput.value = '';
            });
        }

        // Also update previews if someone types/pastes a URL directly
        document.querySelectorAll('.product-img-url').forEach(input => {
            input.addEventListener('input', () => this.refreshModalImagePreviews());
        });

        // Touch swipe gestures for lightbox swiping
        const lightbox = document.getElementById('lightbox-modal');
        if (lightbox) {
            let touchStartX = 0;
            let touchEndX = 0;
            
            lightbox.addEventListener('touchstart', (e) => {
                touchStartX = e.changedTouches[0].screenX;
            }, { passive: true });
            
            lightbox.addEventListener('touchend', (e) => {
                touchEndX = e.changedTouches[0].screenX;
                const diff = touchEndX - touchStartX;
                if (Math.abs(diff) > 50) { // Swipe threshold
                    if (diff > 0) {
                        this.prevLightboxImage();
                    } else {
                        this.nextLightboxImage();
                    }
                }
            }, { passive: true });
        }
        
        // Keyboard navigation for lightbox
        window.addEventListener('keydown', (e) => {
            const modal = document.getElementById('lightbox-modal');
            if (modal && modal.classList.contains('active')) {
                if (e.key === 'ArrowLeft') this.prevLightboxImage();
                if (e.key === 'ArrowRight') this.nextLightboxImage();
                if (e.key === 'Escape') this.closeLightbox();
            }
        });

        // Hire Purchase Form Submission
        document.getElementById('hp-details-form').addEventListener('submit', (e) => {
            e.preventDefault();
            const clientName = document.getElementById('form-hp-client-name').value.trim();
            const phone = document.getElementById('form-hp-client-phone').value.trim();
            const select = document.getElementById('form-hp-product-select');
            let machine = '';
            if (select.value === 'custom') {
                machine = document.getElementById('form-hp-product-custom').value.trim();
            } else {
                machine = select.options[select.selectedIndex].text.split(' (GH₵')[0];
            }
            const price = document.getElementById('form-hp-price').value;
            const deposit = document.getElementById('form-hp-deposit').value;
            const months = document.getElementById('form-hp-months').value;
            const startDate = document.getElementById('form-hp-date').value;
            
            this.saveNewHP(clientName, phone, machine, price, deposit, months, startDate);
        });

        // Change Password Form Submission
        document.getElementById('change-password-form').addEventListener('submit', (e) => {
            e.preventDefault();
            const currentPw = document.getElementById('form-pw-current').value;
            const newPw = document.getElementById('form-pw-new').value;
            const confirmPw = document.getElementById('form-pw-confirm').value;
            
            this.changePassword(currentPw, newPw, confirmPw);
        });
    }

    // Switch Application Views
    switchView(viewName) {
        // Auto-close sidebar on mobile view selection
        const sidebar = document.querySelector('.sidebar');
        const backdrop = document.getElementById('sidebar-backdrop');
        if (sidebar && sidebar.classList.contains('active')) {
            sidebar.classList.remove('active');
            backdrop.classList.remove('active');
        }

        if (!this.isNavigatingHistory) {
            this.viewHistory = this.viewHistory.slice(0, this.viewHistoryPointer + 1);
            this.viewHistory.push(viewName);
            this.viewHistoryPointer = this.viewHistory.length - 1;
        }

        this.activeView = viewName;
        document.querySelectorAll('.app-view').forEach(view => view.style.display = 'none');
        document.querySelectorAll('.nav-item').forEach(btn => btn.classList.remove('active'));

        const pageTitle = document.getElementById('page-title');
        const pageSubtitle = document.getElementById('page-subtitle');
        
        const navBtn = document.getElementById(`nav-btn-${viewName}`);
        if (navBtn) navBtn.classList.add('active');
        
        this.updateNavHistoryButtons();

        switch(viewName) {
            case 'client-store':
                document.getElementById('view-client-store').style.display = 'flex';
                pageTitle.innerText = "Kmap Store";
                pageSubtitle.innerText = "Browse our high performance desktop & portable systems";
                this.renderClientCatalog();
                break;
            case 'client-cart':
                document.getElementById('view-client-cart').style.display = 'block';
                pageTitle.innerText = "Shopping Cart";
                pageSubtitle.innerText = "Review your items and complete payment";
                this.renderCart();
                break;
            case 'client-orders':
                document.getElementById('view-client-orders').style.display = 'block';
                pageTitle.innerText = "My Purchase Orders";
                pageSubtitle.innerText = "Check the live status of your call-in orders";
                this.renderClientOrders();
                break;
            case 'client-find-us':
                document.getElementById('view-client-find-us').style.display = 'block';
                pageTitle.innerText = "Find Us";
                pageSubtitle.innerText = "Locate our physical shop and get in touch";
                break;
            case 'admin-dashboard':
                document.getElementById('view-admin-dashboard').style.display = 'block';
                pageTitle.innerText = "Management Dashboard";
                pageSubtitle.innerText = "Kmap business analytics overview";
                this.renderAdminOverview();
                this.checkLowStockAlerts();
                break;
            case 'admin-orders':
                document.getElementById('view-admin-orders').style.display = 'block';
                pageTitle.innerText = "Order Hub";
                pageSubtitle.innerText = "Manage, verify, and transit client order queues";
                this.renderAdminOrders();
                break;
            case 'admin-inventory':
                document.getElementById('view-admin-inventory').style.display = 'block';
                pageTitle.innerText = "Stock Inventory";
                pageSubtitle.innerText = "Maintain items and stock alert settings";
                this.renderAdminInventory();
                break;
            case 'admin-reports':
                document.getElementById('view-admin-reports').style.display = 'block';
                pageTitle.innerText = "Business Invoicing & Sales Reports";
                pageSubtitle.innerText = "Download printable reports and summaries";
                this.handleReportPresetChange();
                break;
            case 'admin-backups':
                document.getElementById('view-admin-backups').style.display = 'block';
                pageTitle.innerText = "System Administration";
                pageSubtitle.innerText = "Localized system database operations";
                this.renderStaffList();
                this.updateBackupStatus();
                break;
            case 'admin-promos':
                document.getElementById('view-admin-promos').style.display = 'block';
                pageTitle.innerText = "Promotions Manager";
                pageSubtitle.innerText = "Apply catalog-wide discounts or specific product campaigns";
                this.renderPromotions();
                break;
            case 'admin-hp':
                document.getElementById('view-admin-hp').style.display = 'block';
                pageTitle.innerText = "Hire Purchase Management";
                pageSubtitle.innerText = "Monitor client payments, deposits, and installments breakdown";
                this.renderHPList();
                this.checkHPNearDueAlerts();
                break;
        }
    }

    // Navigation generator depending on User Privileges
    renderSidebar() {
        const nav = document.getElementById('sidebar-nav-container');
        if (!nav) return;
        nav.innerHTML = '';

        if (!this.currentUser) return;

        if (this.currentUser.role === 'client' || this.currentUser.role === 'guest') {
            const ordersBtn = this.currentUser.role === 'guest' ? '' : `
                <button class="nav-item" id="nav-btn-client-orders" onclick="app.switchView('client-orders')">
                    <i class="fa-solid fa-list-check"></i> My Orders
                </button>
            `;
            const cartBtn = `
                <button class="nav-item" id="nav-btn-client-cart" onclick="app.switchView('client-cart')">
                    <i class="fa-solid fa-cart-shopping"></i> Shopping Cart (<span class="cart-count">${this.cart.reduce((sum, item) => sum + item.qty, 0)}</span>)
                </button>
            `;
            nav.innerHTML = `
                <button class="nav-item" id="nav-btn-client-store" onclick="app.switchView('client-store')">
                    <i class="fa-solid fa-store"></i> Shop Catalog
                </button>
                ${cartBtn}
                ${ordersBtn}
                <button class="nav-item" id="nav-btn-client-find-us" onclick="app.switchView('client-find-us')">
                    <i class="fa-solid fa-map-location-dot"></i> Find Us
                </button>
            `;
        } else {
            // Admin & Super Admin navbar options
            nav.innerHTML = `
                <button class="nav-item" id="nav-btn-admin-dashboard" onclick="app.switchView('admin-dashboard')">
                    <i class="fa-solid fa-chart-line"></i> Dashboard
                </button>
                <button class="nav-item" id="nav-btn-admin-orders" onclick="app.switchView('admin-orders')">
                    <i class="fa-solid fa-truck-fast"></i> Order Hub
                </button>
                <button class="nav-item" id="nav-btn-admin-inventory" onclick="app.switchView('admin-inventory')">
                    <i class="fa-solid fa-boxes-stacked"></i> Inventory
                </button>
                <button class="nav-item" id="nav-btn-admin-promos" onclick="app.switchView('admin-promos')">
                    <i class="fa-solid fa-tags"></i> Promotions
                </button>
                <button class="nav-item" id="nav-btn-admin-hp" onclick="app.switchView('admin-hp')">
                    <i class="fa-solid fa-file-contract"></i> Hire Purchase
                </button>
                <button class="nav-item" id="nav-btn-admin-reports" onclick="app.switchView('admin-reports')">
                    <i class="fa-solid fa-file-invoice-dollar"></i> Reports
                </button>
                <button class="nav-item" id="nav-btn-admin-backups" onclick="app.switchView('admin-backups')">
                    <i class="fa-solid fa-screwdriver-wrench"></i> Admin Panel
                </button>
            `;
        }

        const logoutBtn = document.getElementById('sidebar-logout-btn');
        if (logoutBtn) {
            if (this.currentUser.role === 'guest') {
                logoutBtn.style.color = 'var(--success)';
                logoutBtn.innerHTML = '<i class="fa-solid fa-user-plus"></i> Sign In / Register';
            } else {
                logoutBtn.style.color = 'var(--error)';
                logoutBtn.innerHTML = '<i class="fa-solid fa-right-from-bracket"></i> Logout';
            }
        }
    }

    renderCategoryFilters() {
        const select = document.getElementById('client-category-select');
        if (!select) return;
        
        const products = this.db.getProducts();
        const categories = ['All', ...new Set(products.map(p => p.category))];
        
        if (select.options.length === 0) {
            select.innerHTML = '';
            categories.forEach(cat => {
                const opt = document.createElement('option');
                opt.value = cat;
                opt.innerText = cat === 'All' ? 'All Categories' : cat;
                select.appendChild(opt);
            });
            
            select.onchange = (e) => {
                this.activeCategory = e.target.value;
                this.renderClientCatalog();
            };
        }
        
        select.value = this.activeCategory;
    }

    // Render client catalog
    renderClientCatalog() {
        if (!this.categoryFiltersInitialized) {
            this.activeCategory = 'All';
            this.categoryFiltersInitialized = true;
        }
        this.renderCategoryFilters();

        const query = document.getElementById('client-search').value.toLowerCase();
        const grid = document.getElementById('products-catalog-grid');
        grid.innerHTML = '';

        const products = this.db.getProducts();
        const filtered = products.filter(p => {
            const matchesQuery = p.name.toLowerCase().includes(query) || p.category.toLowerCase().includes(query);
            const matchesCategory = this.activeCategory === 'All' || p.category.toLowerCase() === this.activeCategory.toLowerCase();
            return matchesQuery && matchesCategory;
        });

        filtered.forEach(p => {
            const discPrice = this.getDiscountedPrice(p);
            const hasPromo = discPrice < p.price;
            const priceHtml = hasPromo 
                ? `<div class="product-price"><span class="original-price">GH₵ ${p.price.toLocaleString(undefined, {minimumFractionDigits: 2})}</span><span class="promo-price">GH₵ ${discPrice.toLocaleString(undefined, {minimumFractionDigits: 2})}</span></div>`
                : `<div class="product-price">GH₵ ${p.price.toLocaleString(undefined, {minimumFractionDigits: 2})}</div>`;
            
            const promoBadge = hasPromo ? `<div class="promo-badge">PROMO</div>` : '';
            
            // Image handling (support up to 6 images, fallback to default laptop/desktop emoji icons)
            const mainImg = (p.images && p.images.length > 0 && p.images[0]) 
                ? `<img src="${p.images[0]}" style="width:100%; height:100%; object-fit:contain; border-radius:var(--radius-sm);">` 
                : `<span style="font-size: 56px; color: var(--primary); display: flex; align-items: center; justify-content: center; width: 100%; height: 100%;">${p.icon || '💻'}</span>`;

            // Split specs by commas or newlines and show only the first two
            const specsArray = p.spec ? p.spec.split(/,|\n/).map(s => s.trim()).filter(s => s.length > 0) : [];
            const shortSpec = specsArray.length > 2 
                ? `${specsArray[0]}, ${specsArray[1]}... <span style="color: var(--primary); font-weight: 700; text-decoration: underline;">See More</span>`
                : (p.spec || 'No specifications listed.');

            const card = document.createElement('div');
            card.className = 'card product-card';
            card.style.position = 'relative';
            card.style.cursor = 'pointer';
            
            // Clicking card opens the product inspect view
            card.innerHTML = `
                ${promoBadge}
                <div onclick="app.openInspectModal('${p.id}')" style="display: flex; flex-direction: column; height: 320px; justify-content: space-between;">
                    <div>
                        <div class="product-img">${mainImg}</div>
                        <h4 style="font-weight: 700; color: var(--text-dark); height: 44px; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; margin-top: 8px; font-size: 15px; line-height: 1.4;">${p.name}</h4>
                        <p style="font-size: 12px; color: var(--text-light); margin-top: 4px; line-height: 1.4;">${shortSpec}</p>
                    </div>
                    ${priceHtml}
                </div>
                <div style="margin-top: 16px; display: flex; justify-content: space-between; align-items: center; position: relative; z-index: 5;">
                    <span style="font-size: 13px; font-weight: 600; color: ${p.stock <= 0 ? 'var(--error)' : 'var(--success)'};">
                        ${p.stock <= 0 ? 'Out of Stock' : 'In Stock'}
                    </span>
                    <button class="btn btn-primary" onclick="event.stopPropagation(); app.addToCart('${p.id}')" ${p.stock <= 0 ? 'disabled' : ''}>
                        <i class="fa-solid fa-cart-plus"></i> Add
                    </button>
                </div>
            `;
            grid.appendChild(card);
        });
    }

    // Client Add to Cart
    addToCart(id) {
        const products = this.db.getProducts();
        const prod = products.find(p => p.id === id);
        
        if (!prod || prod.stock <= 0) return;

        const cartItem = this.cart.find(item => item.id === id);
        const activePrice = this.getDiscountedPrice(prod); // Use promo price!
        if (cartItem) {
            if (cartItem.qty >= prod.stock) {
                this.showToast(`Cannot exceed current stock for ${prod.name}`, 'error');
                return;
            }
            cartItem.qty++;
        } else {
            this.cart.push({ id: prod.id, name: prod.name, price: activePrice, qty: 1, icon: prod.icon });
        }

        this.showToast(`${prod.name} added to cart`);
        this.renderCart();
    }

    // Render Client Cart
    renderCart() {
        this.saveCart();
        const empty = document.getElementById('cart-empty-msg');
        const items = document.getElementById('cart-items-container');
        const summary = document.getElementById('cart-summary');
        
        const mEmpty = document.getElementById('mobile-cart-empty-msg');
        const mItems = document.getElementById('mobile-cart-items-container');
        const mSummary = document.getElementById('mobile-cart-summary');
        
        if (items) items.innerHTML = '';
        if (mItems) mItems.innerHTML = '';
        
        // Update sidebar cart counts
        const totalQty = this.cart.reduce((sum, item) => sum + item.qty, 0);
        document.querySelectorAll('.cart-count').forEach(el => el.innerText = totalQty);
        
        if (this.cart.length === 0) {
            if (empty) empty.style.display = 'block';
            if (summary) summary.style.display = 'none';
            if (mEmpty) mEmpty.style.display = 'block';
            if (mSummary) mSummary.style.display = 'none';
            return;
        }

        if (empty) empty.style.display = 'none';
        if (summary) summary.style.display = 'block';
        if (mEmpty) mEmpty.style.display = 'none';
        if (mSummary) mSummary.style.display = 'block';

        let subtotal = 0;

        this.cart.forEach(item => {
            const totalItemPrice = item.price * item.qty;
            subtotal += totalItemPrice;

            const html = `
                <div onclick="app.viewProductFromCart('${item.id}')" style="cursor: pointer;" title="Click to view details">
                    <h5 style="font-weight: 700; font-size: 13px; text-decoration: underline; color: var(--primary);">${item.name}</h5>
                    <span style="font-size: 11px; color: var(--text-light);">GH₵ ${item.price} each</span>
                </div>
                <div style="display: flex; align-items: center; gap: 8px;">
                    <button class="btn btn-outline" style="padding: 2px 8px; font-size: 11px;" onclick="app.updateCartQty('${item.id}', -1)">-</button>
                    <span style="font-weight: 600; font-size: 13px;">${item.qty}</span>
                    <button class="btn btn-outline" style="padding: 2px 8px; font-size: 11px;" onclick="app.updateCartQty('${item.id}', 1)">+</button>
                    <button class="btn btn-danger" style="padding: 4px 8px; font-size: 11px;" onclick="app.removeFromCart('${item.id}')">
                        <i class="fa-solid fa-trash-can"></i>
                    </button>
                </div>
            `;
            
            if (items) {
                const row = document.createElement('div');
                row.style = 'display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--border); padding-bottom: 8px;';
                row.innerHTML = html;
                items.appendChild(row);
            }
            
            if (mItems) {
                const mRow = document.createElement('div');
                mRow.style = 'display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--border); padding-bottom: 8px;';
                mRow.innerHTML = html;
                mItems.appendChild(mRow);
            }
        });

        const subtotalText = `GH₵ ${subtotal.toLocaleString(undefined, {minimumFractionDigits: 2})}`;
        if (document.getElementById('cart-subtotal')) document.getElementById('cart-subtotal').innerText = subtotalText;
        if (document.getElementById('cart-total')) document.getElementById('cart-total').innerText = subtotalText;
        if (document.getElementById('mobile-cart-subtotal')) document.getElementById('mobile-cart-subtotal').innerText = subtotalText;
        if (document.getElementById('mobile-cart-total')) document.getElementById('mobile-cart-total').innerText = subtotalText;
    }

    updateCartQty(id, diff) {
        const item = this.cart.find(i => i.id === id);
        if (!item) return;

        const products = this.db.getProducts();
        const prod = products.find(p => p.id === id);

        const newQty = item.qty + diff;
        if (newQty <= 0) {
            this.removeFromCart(id);
            return;
        }

        if (newQty > prod.stock) {
            this.showToast(`Sorry, only ${prod.stock} items currently in stock.`, 'error');
            return;
        }

        item.qty = newQty;
        this.renderCart();
    }

    removeFromCart(id) {
        this.cart = this.cart.filter(item => item.id !== id);
        this.renderCart();
        this.showToast("Item removed from cart");
    }

    handleMobileClaimChange(val) {
        const deliveryGroup = document.getElementById('mobile-delivery-address-group');
        if (deliveryGroup) {
            deliveryGroup.style.display = val === 'delivery' ? 'block' : 'none';
        }
    }

    // Placing Order & Redirection Flow
    checkoutCart(isMobile = false) {
        if (this.currentUser.role === 'guest') {
            this.showToast("Account Required: Please sign in or register to place orders.", 'error');
            this.logout(true); // Preserve cart so they don't lose items!
            return;
        }

        const claimMethodEl = document.getElementById(isMobile ? 'mobile-checkout-claim-method' : 'checkout-claim-method') || document.getElementById('mobile-checkout-claim-method');
        const addressEl = document.getElementById(isMobile ? 'mobile-checkout-address' : 'checkout-address') || document.getElementById('mobile-checkout-address');
        
        const claimMethod = claimMethodEl ? claimMethodEl.value : 'walk_in';
        const address = addressEl ? addressEl.value.trim() : '';

        if (claimMethod === 'delivery' && !address) {
            this.showToast("Please provide delivery address details.", 'error');
            return;
        }

        const uniqueId = 'ORD-' + Math.floor(1000 + Math.random() * 9000);
        const subtotal = this.cart.reduce((sum, item) => sum + (item.price * item.qty), 0);
        const userPhone = this.currentUser.phone || this.currentUser.username;

        const newOrder = {
            id: uniqueId,
            clientName: this.currentUser.name,
            phone: userPhone,
            items: [...this.cart],
            total: subtotal,
            claimMethod: claimMethod,
            address: claimMethod === 'delivery' ? address : '',
            date: new Date().toISOString(),
            status: 'pending'
        };

        // Deduct inventory stock
        const products = this.db.getProducts();
        newOrder.items.forEach(cItem => {
            const p = products.find(prod => prod.id === cItem.id);
            if (p) p.stock = Math.max(0, p.stock - cItem.qty);
        });

        const orders = this.db.getOrders();
        orders.unshift(newOrder);
        this.db.saveOrders(orders);
        this.db.saveProducts(products);
        this.db.addLog(`Placed pending order ${uniqueId} total: GH₵ ${subtotal}`);

        // Reset Cart
        this.cart = [];
        this.renderCart();
        
        // Show support line payment instructions modal
        const orderIdEl = document.getElementById('modal-order-id');
        if (orderIdEl) orderIdEl.innerText = uniqueId;
        
        const callOverlay = document.getElementById('modal-checkout-call');
        if (callOverlay) {
            if (claimMethod === 'hire_purchase') {
                callOverlay.querySelector('.modal-content').innerHTML = `
                    <button onclick="app.cancelCheckout('${uniqueId}', false)" style="position: absolute; top: 16px; right: 16px; background: none; border: none; font-size: 20px; cursor: pointer; color: var(--text-muted); padding: 4px; display: flex; align-items: center; justify-content: center;" aria-label="Close">
                        <i class="fa-solid fa-xmark"></i>
                    </button>
                    <h3 style="color: var(--primary); font-weight: 800; font-size: 22px; margin-bottom: 12px;">
                        <i class="fa-solid fa-file-signature"></i> Hire Purchase Request
                    </h3>
                    
                    <div style="background: rgba(218, 145, 0, 0.1); border-left: 4px solid var(--primary); padding: 16px; border-radius: var(--radius-sm); margin-bottom: 20px;">
                        <strong style="color: var(--primary);">Reference ID generated:</strong>
                        <p id="modal-order-id" style="font-family: monospace; font-size: 18px; font-weight: 700; margin-top: 8px; color: var(--text-dark);">${uniqueId}</p>
                    </div>
                    
                    <p style="font-size: 14px; margin-bottom: 20px; color: var(--text-dark);">
                        Your request for Hire Purchase has been logged. <strong>Note:</strong> Hire Purchase agreements must be completed physically at our shop. Please visit us with your ID and initial deposit.
                    </p>
                    
                    <div style="display: flex; flex-direction: column; gap: 12px;">
                        <div style="display: flex; gap: 12px;">
                            <a href="tel:+233240000000" onclick="app.closeModal()" class="btn btn-primary" style="text-decoration: none; height: 48px; color: #000000; font-weight: 700; display: flex; align-items: center; justify-content: center; gap: 8px; flex: 1; font-size: 13px; padding: 0 4px;">
                                <i class="fa-solid fa-phone"></i> Call to Complete
                            </a>
                            <a href="https://wa.me/233240000000?text=Hi,%20I'd%20like%20to%20complete%20my%20hire%20purchase%20request%20${uniqueId}" target="_blank" onclick="app.closeModal()" class="btn btn-success" style="text-decoration: none; height: 48px; color: white; background-color: #25D366; border-color: #25D366; font-weight: 700; display: flex; align-items: center; justify-content: center; gap: 8px; flex: 1; font-size: 13px; padding: 0 4px;">
                                <i class="fa-brands fa-whatsapp"></i> WhatsApp Us
                            </a>
                        </div>
                        <button class="btn btn-danger" style="height: 40px; font-size: 13px;" onclick="app.cancelCheckout('${uniqueId}', false)">
                            <i class="fa-solid fa-trash-can"></i> Cancel Request & Revert Cart
                        </button>
                    </div>
                `;
            } else {
                callOverlay.querySelector('.modal-content').innerHTML = `
                    <button onclick="app.cancelCheckout('${uniqueId}', false)" style="position: absolute; top: 16px; right: 16px; background: none; border: none; font-size: 20px; cursor: pointer; color: var(--text-muted); padding: 4px; display: flex; align-items: center; justify-content: center;" aria-label="Close">
                        <i class="fa-solid fa-xmark"></i>
                    </button>
                    <h3 style="color: var(--secondary); font-weight: 800; font-size: 22px; margin-bottom: 12px;">
                        <i class="fa-solid fa-phone-volume"></i> Complete Your Order
                    </h3>
                    
                    <div style="background: rgba(245, 198, 33, 0.1); border-left: 4px solid var(--secondary); padding: 16px; border-radius: var(--radius-sm); margin-bottom: 20px;">
                        <strong style="color: var(--secondary);">Order Receipt & Unique ID generated:</strong>
                        <p id="modal-order-id" style="font-family: monospace; font-size: 18px; font-weight: 700; margin-top: 8px; color: var(--text-dark);">${uniqueId}</p>
                    </div>
                    
                    <p style="font-size: 14px; margin-bottom: 20px; color: var(--text-dark);">
                        Please contact our support line directly to make your payment and receive order confirmation details afterwards.
                    </p>
                    
                    <div style="display: flex; flex-direction: column; gap: 12px;">
                        <div style="display: flex; gap: 12px;">
                            <a href="tel:+233240000000" onclick="app.closeModal()" class="btn btn-primary" style="text-decoration: none; height: 48px; color: #000000; font-weight: 700; display: flex; align-items: center; justify-content: center; gap: 8px; flex: 1; font-size: 13px; padding: 0 4px;">
                                <i class="fa-solid fa-phone"></i> Call to Complete
                            </a>
                            <a href="https://wa.me/233240000000?text=Hi,%20I'd%20like%20to%20complete%20my%20order%20${uniqueId}" target="_blank" onclick="app.closeModal()" class="btn btn-success" style="text-decoration: none; height: 48px; color: white; background-color: #25D366; border-color: #25D366; font-weight: 700; display: flex; align-items: center; justify-content: center; gap: 8px; flex: 1; font-size: 13px; padding: 0 4px;">
                                <i class="fa-brands fa-whatsapp"></i> WhatsApp Us
                            </a>
                        </div>
                        <button class="btn btn-danger" style="height: 40px; font-size: 13px;" onclick="app.cancelCheckout('${uniqueId}', false)">
                            <i class="fa-solid fa-trash-can"></i> Cancel Order & Revert Cart
                        </button>
                    </div>
                `;
            }
            callOverlay.classList.add('active');
        }
    }

    cancelCheckout(orderId, showToast = true) {
        const orders = this.db.getOrders();
        const orderIndex = orders.findIndex(o => o.id === orderId);
        
        if (orderIndex > -1) {
            const order = orders[orderIndex];
            
            // Restore inventory stock
            const products = this.db.getProducts();
            order.items.forEach(cItem => {
                const p = products.find(prod => prod.id === cItem.id);
                if (p) p.stock += cItem.qty;
            });
            
            // Restore cart
            this.cart = [...order.items];
            
            // Remove order
            orders.splice(orderIndex, 1);
            
            // Save & Rerender
            this.db.saveOrders(orders);
            this.db.saveProducts(products);
            this.db.addLog(`Cancelled checkout for order ${orderId}, restored cart & stock.`);
            
            this.renderCart();
            this.renderClientCatalog();
            if (showToast) {
                this.showToast("Checkout cancelled. Items restored to your cart.");
            }
        }
        
        document.getElementById('modal-checkout-call').classList.remove('active');
        this.switchView('client-cart');
    }

    closeModal() {
        document.getElementById('modal-checkout-call').classList.remove('active');
        this.switchView('client-orders');
    }

    // Promotions pricing utility
    getDiscountedPrice(p) {
        const promos = this.db.getPromos();
        let bestPrice = p.price;
        promos.forEach(promo => {
            let matches = false;
            if (promo.scope === 'category' && promo.category.toLowerCase() === p.category.toLowerCase()) {
                matches = true;
            } else if (promo.scope === 'product' && promo.productId === p.id) {
                matches = true;
            }
            if (matches) {
                let discounted = p.price;
                if (promo.type === 'percent') {
                    discounted = p.price * (1 - parseFloat(promo.value) / 100);
                } else if (promo.type === 'amount') {
                    discounted = Math.max(0, p.price - parseFloat(promo.value));
                }
                if (discounted < bestPrice) {
                    bestPrice = discounted;
                }
            }
        });
        return bestPrice;
    }

    handlePromoScopeChange() {
        const scope = document.getElementById('promo-scope').value;
        document.getElementById('promo-category-group').style.display = scope === 'category' ? 'block' : 'none';
        document.getElementById('promo-product-group').style.display = scope === 'product' ? 'block' : 'none';
    }

    renderPromotions() {
        const productsSelect = document.getElementById('promo-product');
        if (productsSelect) {
            productsSelect.innerHTML = '';
            const products = this.db.getProducts();
            products.forEach(p => {
                const opt = document.createElement('option');
                opt.value = p.id;
                opt.innerText = `${p.name} (${p.category})`;
                productsSelect.appendChild(opt);
            });
        }

        const tbody = document.getElementById('promos-list-tbody');
        if (tbody) {
            tbody.innerHTML = '';
            const promos = this.db.getPromos();
            if (promos.length === 0) {
                tbody.innerHTML = `<tr><td colspan="3" style="text-align: center; color: var(--text-light)">No active promotions.</td></tr>`;
                return;
            }

            promos.forEach(p => {
                const tr = document.createElement('tr');
                let targetText = '';
                if (p.scope === 'category') {
                    targetText = `Category: <strong>${p.category}</strong>`;
                } else {
                    const products = this.db.getProducts();
                    const prod = products.find(item => item.id === p.productId);
                    targetText = `Product: <strong>${prod ? prod.name : p.productId}</strong>`;
                }

                const valText = p.type === 'percent' ? `${p.value}% Off` : `GH₵ ${p.value} Off`;

                tr.innerHTML = `
                    <td>${targetText}</td>
                    <td><span class="badge badge-success">${valText}</span></td>
                    <td>
                        <button class="btn btn-danger" style="padding: 4px 8px; font-size: 11px;" onclick="app.deletePromotion('${p.id}')">Remove</button>
                    </td>
                `;
                tbody.appendChild(tr);
            });
        }
    }

    createPromotion(scope, category, productId, type, value) {
        const promos = this.db.getPromos();
        const newPromo = {
            id: 'PROMO-' + Math.floor(1000 + Math.random() * 9000),
            scope,
            category: scope === 'category' ? category : '',
            productId: scope === 'product' ? productId : '',
            type,
            value: parseFloat(value) || 0
        };
        promos.push(newPromo);
        this.db.savePromos(promos);
        this.db.addLog(`Created promotion ${newPromo.id} - ${scope} discount`);
        this.showToast("Promotion created successfully!");
        this.renderPromotions();
    }

    deletePromotion(id) {
        let promos = this.db.getPromos();
        promos = promos.filter(p => p.id !== id);
        this.db.savePromos(promos);
        this.showToast("Promotion removed");
        this.renderPromotions();
    }

    viewProductFromCart(productId) {
        this.inspectBackView = 'client-cart';
        this.switchView('client-store');
        this.openInspectModal(productId);
    }

    openInspectModal(productId) {
        const products = this.db.getProducts();
        const p = products.find(item => item.id === productId);
        if (!p) return;

        document.getElementById('inspect-product-name').innerText = p.name;
        document.getElementById('inspect-product-category').innerText = p.category;
        document.getElementById('inspect-product-spec').innerText = p.spec || 'No specifications listed.';
        
        const statusEl = document.getElementById('inspect-product-stock-status');
        if (p.stock <= 0) {
            statusEl.innerText = 'OUT OF STOCK';
            statusEl.className = 'badge badge-error';
        } else {
            statusEl.innerText = 'AVAILABLE';
            statusEl.className = 'badge badge-success';
        }

        const discPrice = this.getDiscountedPrice(p);
        const hasPromo = discPrice < p.price;
        const originalPriceEl = document.getElementById('inspect-product-original-price');
        const priceEl = document.getElementById('inspect-product-price');
        
        if (hasPromo) {
            originalPriceEl.style.display = 'inline';
            originalPriceEl.innerText = `GH₵ ${p.price.toLocaleString(undefined, {minimumFractionDigits: 2})}`;
            priceEl.innerText = `GH₵ ${discPrice.toLocaleString(undefined, {minimumFractionDigits: 2})}`;
        } else {
            originalPriceEl.style.display = 'none';
            priceEl.innerText = `GH₵ ${p.price.toLocaleString(undefined, {minimumFractionDigits: 2})}`;
        }

        const mainImgDisplay = document.getElementById('inspect-img-display');
        const thumbContainer = document.getElementById('inspect-thumbnails-container');
        thumbContainer.innerHTML = '';

        let images = p.images || [];
        if (images.length === 0) {
            mainImgDisplay.src = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 24 24" fill="none" stroke="%2394a3b8" stroke-width="2"><rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18"/><line x1="7" y1="2" x2="7" y2="22"/><line x1="17" y1="2" x2="17" y2="22"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="2" y1="7" x2="7" y2="7"/><line x1="2" y1="17" x2="7" y2="17"/><line x1="17" y1="17" x2="22" y2="17"/><line x1="17" y1="7" x2="22" y2="7"/></svg>';
            mainImgDisplay.style.opacity = '0.5';
            mainImgDisplay.onclick = null;
        } else {
            mainImgDisplay.src = images[0];
            mainImgDisplay.style.opacity = '1';
            mainImgDisplay.onclick = () => { this.openLightbox(mainImgDisplay.src, productId); };
            
            images.forEach((imgSrc, idx) => {
                const thumb = document.createElement('div');
                thumb.className = `inspect-thumb ${idx === 0 ? 'active' : ''}`;
                thumb.innerHTML = `<img src="${imgSrc}">`;
                thumb.onclick = () => {
                    document.querySelectorAll('.inspect-thumb').forEach(t => t.classList.remove('active'));
                    thumb.classList.add('active');
                    mainImgDisplay.src = imgSrc;
                };
                thumbContainer.appendChild(thumb);
            });
        }

        const cartBtn = document.getElementById('inspect-add-to-cart-btn');
        if (p.stock <= 0) {
            cartBtn.disabled = true;
            cartBtn.innerText = 'Out of Stock';
        } else {
            cartBtn.disabled = false;
            cartBtn.innerText = 'Add to Shopping Cart';
            cartBtn.onclick = () => {
                this.addToCart(p.id);
                this.closeInspectModal();
            };
        }

        document.getElementById('modal-product-inspect').classList.add('active');
    }

    closeInspectModal() {
        document.getElementById('modal-product-inspect').classList.remove('active');
        if (this.inspectBackView) {
            this.switchView(this.inspectBackView);
            this.inspectBackView = null;
        }
    }

    openLightbox(src, productId = null) {
        const modal = document.getElementById('lightbox-modal');
        const img = document.getElementById('lightbox-img');
        if (modal && img) {
            img.src = src;
            modal.classList.add('active');
            
            this.lightboxImages = [];
            this.lightboxIndex = -1;
            
            if (productId) {
                const products = this.db.getProducts();
                const p = products.find(item => item.id === productId);
                if (p && p.images && p.images.length > 0) {
                    this.lightboxImages = p.images;
                    this.lightboxIndex = p.images.indexOf(src);
                }
            }
            
            const prevBtn = document.querySelector('.lightbox-prev-btn');
            const nextBtn = document.querySelector('.lightbox-next-btn');
            if (prevBtn && nextBtn) {
                if (this.lightboxImages.length > 1) {
                    prevBtn.style.display = 'flex';
                    nextBtn.style.display = 'flex';
                } else {
                    prevBtn.style.display = 'none';
                    nextBtn.style.display = 'none';
                }
            }
        }
    }

    closeLightbox() {
        const modal = document.getElementById('lightbox-modal');
        if (modal) {
            modal.classList.remove('active');
        }
    }

    nextLightboxImage() {
        if (this.lightboxImages && this.lightboxImages.length > 1 && this.lightboxIndex > -1) {
            this.lightboxIndex = (this.lightboxIndex + 1) % this.lightboxImages.length;
            document.getElementById('lightbox-img').src = this.lightboxImages[this.lightboxIndex];
        }
    }

    prevLightboxImage() {
        if (this.lightboxImages && this.lightboxImages.length > 1 && this.lightboxIndex > -1) {
            this.lightboxIndex = (this.lightboxIndex - 1 + this.lightboxImages.length) % this.lightboxImages.length;
            document.getElementById('lightbox-img').src = this.lightboxImages[this.lightboxIndex];
        }
    }

    checkLowStockAlerts() {
        const products = this.db.getProducts();
        const lowStockItems = products.filter(p => p.stock <= 3);
        if (lowStockItems.length > 0 && (this.currentUser.role === 'admin' || this.currentUser.role === 'superadmin')) {
            const names = lowStockItems.map(p => `${p.name} (${p.stock} left)`).join(', ');
            this.showToast(`Low Stock Alert: ${names}`, 'error');
        }
    }

    toggleSidebar() {
        const sidebar = document.querySelector('.sidebar');
        const backdrop = document.getElementById('sidebar-backdrop');
        if (sidebar && backdrop) {
            sidebar.classList.toggle('active');
            backdrop.classList.toggle('active');
        }
    }

    // Client Order List rendering
    renderClientOrders() {
        const tbody = document.getElementById('client-orders-tbody');
        tbody.innerHTML = '';

        const orders = this.db.getOrders();
        // filter user specific
        const clientPhone = this.currentUser.phone || this.currentUser.username;
        let clientOrders = orders.filter(o => o.phone === clientPhone);

        // Filter by search query if search input exists
        const searchInput = document.getElementById('order-search');
        const query = searchInput ? searchInput.value.trim().toLowerCase() : '';
        if (query) {
            clientOrders = clientOrders.filter(o => {
                const matchesId = o.id.toLowerCase().includes(query);
                const matchesMachine = o.items.some(item => item.name.toLowerCase().includes(query));
                return matchesId || matchesMachine;
            });
        }

        if (clientOrders.length === 0) {
            tbody.innerHTML = `<tr><td colspan="8" style="text-align: center; color: var(--text-light)">No orders found.</td></tr>`;
            return;
        }

        clientOrders.forEach(o => {
            const tr = document.createElement('tr');
            const dateStr = new Date(o.date).toLocaleDateString('en-US', {month: 'short', day: 'numeric', year: 'numeric'});
            const itemsStr = o.items.map(i => `${i.name} (${i.qty})`).join(', ');
            
            let badgeClass = 'badge-pending';
            if (o.status === 'confirmed') badgeClass = 'badge-confirmed';
            if (o.status === 'in_transit') badgeClass = 'badge-transit';
            if (o.status === 'completed') badgeClass = 'badge-completed';
            if (o.status === 'void') badgeClass = 'badge-void';

            tr.innerHTML = `
                <td style="text-align: center;"><input type="checkbox" class="client-order-select" value="${o.id}"></td>
                <td><strong>${o.id}</strong></td>
                <td>${dateStr}</td>
                <td>${itemsStr}</td>
                <td>${o.claimMethod.replace('_', ' ').toUpperCase()}</td>
                <td><strong>GH₵ ${o.total.toLocaleString(undefined, {minimumFractionDigits: 2})}</strong></td>
                <td><span class="badge ${badgeClass}">${o.status.toUpperCase()}</span></td>
                <td>
                    <button class="btn btn-outline" style="padding: 4px 8px; font-size: 12px;" onclick="app.downloadInvoicePDF('${o.id}')"><i class="fa-solid fa-file-pdf"></i> Download</button>
                </td>
            `;
            tbody.appendChild(tr);
        });
    }

    // ADMIN: Render Overviews & Dashboard Analytics
    renderAdminOverview() {
        const orders = this.db.getOrders();
        const products = this.db.getProducts();

        // Stats calculations: include completed and confirmed orders in revenue
        const completed = orders.filter(o => ['completed', 'confirmed'].includes(o.status));
        const revenue = completed.reduce((sum, o) => sum + o.total, 0);
        const active = orders.filter(o => ['pending', 'confirmed', 'in_transit'].includes(o.status)).length;
        const pending = orders.filter(o => o.status === 'pending').length;
        const lowStock = products.filter(p => p.stock <= 3).length;

        document.getElementById('stat-revenue').innerText = `GH₵ ${revenue.toLocaleString(undefined, {minimumFractionDigits: 2})}`;
        document.getElementById('stat-active-orders').innerText = active;
        document.getElementById('stat-pending-orders').innerText = pending;
        document.getElementById('stat-low-stock').innerText = lowStock;

        // Recent Orders Table
        const recentTbody = document.getElementById('recent-orders-tbody');
        recentTbody.innerHTML = '';
        orders.slice(0, 5).forEach(o => {
            const tr = document.createElement('tr');
            tr.style.cursor = 'pointer';
            tr.onclick = () => this.viewOrderDetails(o.id);
            tr.title = "Click to view order details";
            
            let badgeClass = 'badge-pending';
            if (o.status === 'confirmed') badgeClass = 'badge-confirmed';
            if (o.status === 'in_transit') badgeClass = 'badge-transit';
            if (o.status === 'completed') badgeClass = 'badge-completed';
            if (o.status === 'void') badgeClass = 'badge-void';

            tr.innerHTML = `
                <td><strong>${o.id}</strong></td>
                <td>${o.clientName}</td>
                <td>GH₵ ${o.total.toLocaleString(undefined, {minimumFractionDigits: 2})}</td>
                <td><span class="badge ${badgeClass}">${o.status.toUpperCase()}</span></td>
            `;
            recentTbody.appendChild(tr);
        });

        // Initialize Analytics Chart
        setTimeout(() => this.renderAnalyticsChart(completed), 100);
    }

    showActiveOrders() {
        this.switchView('admin-orders');
        const filter = document.getElementById('admin-order-status-filter');
        if (filter) {
            filter.value = 'active_all';
            const searchInput = document.getElementById('admin-order-search');
            if (searchInput) searchInput.value = '';
            this.renderAdminOrders();
        }
    }

    showPendingOrders() {
        this.switchView('admin-orders');
        const filter = document.getElementById('admin-order-status-filter');
        if (filter) {
            filter.value = 'pending';
            const searchInput = document.getElementById('admin-order-search');
            if (searchInput) searchInput.value = '';
            this.renderAdminOrders();
        }
    }

    showLowStockItems() {
        this.switchView('admin-inventory');
        this.renderAdminInventory(true);
    }

    viewOrderDetails(orderId) {
        this.switchView('admin-orders');
        const filter = document.getElementById('admin-order-status-filter');
        if (filter) filter.value = 'all';
        const searchInput = document.getElementById('admin-order-search');
        if (searchInput) searchInput.value = orderId;
        this.renderAdminOrders(orderId);
    }

    // Chart.js sales trending
    renderAnalyticsChart(completedOrders) {
        const ctx = document.getElementById('salesChart');
        if (!ctx) return;

        if (this.salesChart) {
            this.salesChart.destroy();
        }

        // Aggregate last 7 days of sales
        const dates = [];
        const data = [];
        for (let i = 6; i >= 0; i--) {
            const d = new Date();
            d.setDate(d.getDate() - i);
            const dStr = d.toLocaleDateString('en-US', {month: 'short', day: 'numeric'});
            dates.push(dStr);
            
            // Sum sales for that day
            const startDay = new Date(d.setHours(0,0,0,0)).getTime();
            const endDay = new Date(d.setHours(23,59,59,999)).getTime();
            
            const daySales = completedOrders
                .filter(o => {
                    const oTime = new Date(o.date).getTime();
                    return oTime >= startDay && oTime <= endDay;
                })
                .reduce((sum, o) => sum + o.total, 0);
            
            data.push(daySales);
        }

        if (typeof Chart === 'undefined') {
            console.warn("Chart.js is not loaded.");
            return;
        }

        this.salesChart = new Chart(ctx, {
            type: 'line',
            data: {
                labels: dates,
                datasets: [{
                    label: 'Daily Revenue (GH₵)',
                    data: data,
                    borderColor: '#2E7D64',
                    backgroundColor: 'rgba(46, 125, 100, 0.1)',
                    borderWidth: 2,
                    fill: true,
                    tension: 0.3
                }]
            },
            options: {
                responsive: true,
                plugins: {
                    legend: { display: false }
                },
                scales: {
                    y: { beginAtZero: true }
                }
            }
        });
    }

    // ADMIN: Orders management hub
    renderAdminOrders(searchQuery = '') {
        const tbody = document.getElementById('admin-orders-tbody');
        tbody.innerHTML = '';

        let orders = this.db.getOrders();
        
        // Search query filter
        if (searchQuery) {
            const queryLower = searchQuery.toLowerCase();
            orders = orders.filter(o => o.id.toLowerCase().includes(queryLower) || o.clientName.toLowerCase().includes(queryLower));
        }

        // Status filter
        const statusFilterEl = document.getElementById('admin-order-status-filter');
        if (statusFilterEl) {
            const statusFilter = statusFilterEl.value;
            if (statusFilter === 'active_all') {
                orders = orders.filter(o => ['pending', 'confirmed', 'in_transit'].includes(o.status));
            } else if (statusFilter !== 'all') {
                orders = orders.filter(o => o.status === statusFilter);
            }
        }

        if (orders.length === 0) {
            tbody.innerHTML = `<tr><td colspan="8" style="text-align: center; color: var(--text-light)">No matching client orders found.</td></tr>`;
            return;
        }
        orders.forEach(o => {
            const tr = document.createElement('tr');
            const itemsStr = o.items.map(i => `${i.name} (x${i.qty})`).join(', ');
            const dateStr = new Date(o.date).toLocaleString('en-US', {month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'});

            let selectStyle = 'border: 1px solid var(--border);';
            if (o.status === 'pending') selectStyle = 'background-color: rgba(244, 180, 0, 0.15); color: #B07D00; font-weight: 700; border-color: #F4B400;';
            if (o.status === 'confirmed') selectStyle = 'background-color: rgba(66, 133, 244, 0.15); color: #1A73E8; font-weight: 700; border-color: #4285F4;';
            if (o.status === 'in_transit') selectStyle = 'background-color: rgba(147, 51, 234, 0.15); color: #7E22CE; font-weight: 700; border-color: #9333EA;';
            if (o.status === 'completed') selectStyle = 'background-color: rgba(52, 168, 83, 0.15); color: #137333; font-weight: 700; border-color: #34A853;';
            if (o.status === 'void') selectStyle = 'background-color: rgba(217, 48, 37, 0.15); color: #C5221F; font-weight: 700; border-color: #D93025;';

            tr.innerHTML = `
                <td><strong>${o.id}</strong></td>
                <td>
                    <strong>${o.clientName}</strong><br>
                    <span style="font-size:12px; color: var(--text-light);">${o.phone}</span>
                </td>
                <td><span style="font-size:13px;">${itemsStr}</span></td>
                <td>${dateStr}</td>
                <td>
                    <span style="font-size: 12px; font-weight: 600;">${o.claimMethod.toUpperCase()}</span><br>
                    <span style="font-size:11px; color: var(--text-light);">${o.address || 'In-store Pick up'}</span>
                </td>
                <td><strong>GH₵ ${o.total.toLocaleString(undefined, {minimumFractionDigits: 2})}</strong></td>
                <td>
                    <select class="form-control" style="${selectStyle} width: 140px; font-size:12px; padding: 6px 12px; border-radius: var(--radius-sm);" onchange="app.updateOrderStatus('${o.id}', this.value)">
                        <option value="pending" ${o.status === 'pending' ? 'selected' : ''}>PENDING</option>
                        <option value="confirmed" ${o.status === 'confirmed' ? 'selected' : ''}>CONFIRMED</option>
                        <option value="in_transit" ${o.status === 'in_transit' ? 'selected' : ''}>IN TRANSIT</option>
                        <option value="completed" ${o.status === 'completed' ? 'selected' : ''}>COMPLETED</option>
                        <option value="void" ${o.status === 'void' ? 'selected' : ''}>VOID (TRASH)</option>
                    </select>
                </td>
                <td>
                    <button class="btn btn-outline" style="padding: 4px 8px; font-size: 11px;" onclick="app.downloadInvoicePDF('${o.id}')"><i class="fa-solid fa-file-pdf"></i> Download</button>
                </td>
            `;
            tbody.appendChild(tr);
        });
    }

    searchOrders() {
        const query = document.getElementById('admin-order-search').value.toLowerCase().trim();
        this.renderAdminOrders(query);
    }

    updateOrderStatus(orderId, newStatus) {
        const orders = this.db.getOrders();
        const order = orders.find(o => o.id === orderId);
        
        if (order) {
            order.status = newStatus;
            this.db.saveOrders(orders);
            this.db.addLog(`Updated order status ${orderId} to: ${newStatus}`);
            this.showToast(`Order status updated to ${newStatus}`);
            
            if (this.activeView === 'admin-dashboard') this.renderAdminOverview();
            if (this.activeView === 'admin-orders') this.renderAdminOrders();
        }
    }

    downloadInvoicePDF(orderId) {
        const orders = this.db.getOrders();
        const o = orders.find(item => item.id === orderId);
        if (!o) return;

        const { jsPDF } = window.jspdf;
        const doc = new jsPDF();
        
        doc.setFont("helvetica", "bold");
        doc.setFontSize(22);
        doc.text("Kmap Computers - Invoice", 14, 20);
        
        doc.setFontSize(11);
        doc.setFont("helvetica", "normal");
        doc.text(`Order ID: ${o.id}`, 14, 30);
        doc.text(`Date: ${new Date(o.date).toLocaleString()}`, 14, 36);
        doc.text(`Customer Name: ${o.clientName}`, 14, 42);
        doc.text(`Phone: ${o.phone}`, 14, 48);
        doc.text(`Claiming Option: ${o.claimMethod.replace('_', ' ').toUpperCase()}`, 14, 54);
        doc.text(`Order Status: ${o.status.toUpperCase()}`, 14, 60);
        let nextY = 66;
        if (o.address) {
            doc.text(`Delivery Address: ${o.address}`, 14, nextY);
            nextY += 6;
        }

        doc.line(14, nextY, 196, nextY);
        
        doc.setFont("helvetica", "bold");
        doc.text("Items Ordered", 14, nextY + 8);
        
        let y = nextY + 18;
        doc.setFont("helvetica", "normal");
        o.items.forEach((item, idx) => {
            const text = `${idx + 1}. ${item.name} (x${item.qty}) - GHS ${item.price.toLocaleString()} each`;
            doc.text(text, 14, y);
            y += 8;
        });

        doc.line(14, y + 4, 196, y + 4);
        doc.setFont("helvetica", "bold");
        doc.setFontSize(14);
        doc.text(`Total Amount: GHS ${o.total.toLocaleString(undefined, {minimumFractionDigits: 2})}`, 14, y + 14);

        doc.save(`KMAP_Invoice_${o.id}.pdf`);
        this.db.addLog(`Downloaded invoice for order ${o.id}`);
    }

    toggleSelectAll(selector, checked) {
        document.querySelectorAll(selector).forEach(checkbox => {
            checkbox.checked = checked;
        });
    }

    downloadSelectedInvoices(selector) {
        const checkboxes = document.querySelectorAll(`${selector}:checked`);
        if (checkboxes.length === 0) {
            this.showToast("Please select at least one order to download.", "error");
            return;
        }
        checkboxes.forEach(checkbox => {
            this.downloadInvoicePDF(checkbox.value);
        });
    }

    downloadAllInvoices() {
        const orders = this.db.getOrders();
        
        let filteredOrders = [...orders];
        const searchQuery = document.getElementById('admin-order-search').value.toLowerCase().trim();
        if (searchQuery) {
            filteredOrders = filteredOrders.filter(o => o.id.toLowerCase().includes(searchQuery) || o.clientName.toLowerCase().includes(searchQuery));
        }
        const statusFilterEl = document.getElementById('admin-order-status-filter');
        if (statusFilterEl) {
            const statusFilter = statusFilterEl.value;
            if (statusFilter !== 'all') {
                filteredOrders = filteredOrders.filter(o => o.status === statusFilter);
            }
        }

        if (filteredOrders.length === 0) {
            this.showToast("No orders available to export.", 'error');
            return;
        }

        const { jsPDF } = window.jspdf;
        const doc = new jsPDF();
        
        doc.setFont("helvetica", "bold");
        doc.setFontSize(22);
        doc.text("Kmap Computers - System Orders List", 14, 20);
        
        doc.setFontSize(10);
        doc.setFont("helvetica", "normal");
        doc.text(`Generated: ${new Date().toLocaleString()}`, 14, 28);
        doc.text(`Total Orders: ${filteredOrders.length}`, 14, 34);

        doc.line(14, 40, 196, 40);
        
        let y = 48;
        filteredOrders.forEach((o, idx) => {
            const dateStr = new Date(o.date).toLocaleDateString();
            const itemsStr = o.items.map(i => `${i.name} (x${i.qty})`).join(', ');
            const text = `${idx + 1}. ID: ${o.id} | ${o.clientName} | ${dateStr} | ${o.status.toUpperCase()} | GHS ${o.total.toLocaleString()}`;
            doc.text(text, 14, y);
            y += 8;
            
            doc.setFontSize(8);
            doc.text(`   Items: ${itemsStr}`, 14, y);
            y += 10;
            doc.setFontSize(10);
            
            if (y > 280) {
                doc.addPage();
                y = 20;
            }
        });

        doc.save(`KMAP_Orders_Export_${Date.now()}.pdf`);
        this.db.addLog(`Downloaded bulk orders list export`);
    }

    // ADMIN: Stock & Inventory Page
    renderAdminInventory(filterLowStock = false) {
        const tbody = document.getElementById('admin-inventory-tbody');
        tbody.innerHTML = '';

        let products = this.db.getProducts();
        if (filterLowStock) {
            products = products.filter(p => p.stock <= 3);
        }
        products.forEach(p => {
            const hasImg = p.images && p.images.length > 0 && p.images[0];
            const iconOrImg = hasImg 
                ? `<img src="${p.images[0]}" style="width:36px; height:36px; object-fit:contain; border-radius:4px; border:1px solid var(--border); background:#fff;">` 
                : `<span style="font-size: 20px;">${p.icon || '💻'}</span>`;

            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td><code>${p.id}</code></td>
                <td>
                    <div style="display:flex; align-items:center; gap:8px;">
                        ${iconOrImg}
                        <strong>${p.name}</strong>
                    </div>
                </td>
                <td>${p.category}</td>
                <td><strong>GH₵ ${p.price.toLocaleString()}</strong></td>
                <td>
                    <input type="number" class="form-control" style="width: 80px; padding: 4px 8px;" value="${p.stock}" onchange="app.updateProductStock('${p.id}', this.value)">
                </td>
                <td>
                    <button class="btn btn-outline" style="padding: 4px 8px; font-size: 12px;" onclick="app.openProductModal('${p.id}')"><i class="fa-solid fa-pen"></i></button>
                    <button class="btn btn-danger" style="padding: 4px 8px; font-size: 12px;" onclick="app.deleteProduct('${p.id}')"><i class="fa-solid fa-trash"></i></button>
                </td>
            `;
            tbody.appendChild(tr);
        });
    }

    updateProductStock(prodId, newStock) {
        const products = this.db.getProducts();
        const p = products.find(item => item.id === prodId);
        if (p) {
            p.stock = Math.max(0, parseInt(newStock) || 0);
            this.db.saveProducts(products);
            this.showToast(`Stock updated for ${p.name}`);
        }
    }

    // Helper: compress any image file to clean thumbnail JPEG
    compressImageFile(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onerror = reject;
            reader.onload = (e) => {
                const img = new Image();
                img.onerror = reject;
                img.onload = () => {
                    const canvas = document.createElement('canvas');
                    const MAX_WIDTH = 500;
                    const MAX_HEIGHT = 500;
                    let width = img.width;
                    let height = img.height;

                    if (width > height) {
                        if (width > MAX_WIDTH) {
                            height *= MAX_WIDTH / width;
                            width = MAX_WIDTH;
                        }
                    } else {
                        if (height > MAX_HEIGHT) {
                            width *= MAX_HEIGHT / height;
                            height = MAX_HEIGHT;
                        }
                    }

                    canvas.width = Math.round(width);
                    canvas.height = Math.round(height);
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                    // Standardize to clean, lightweight JPEG
                    const base64 = canvas.toDataURL('image/jpeg', 0.75);
                    resolve(base64);
                };
                img.src = e.target.result;
            };
            reader.readAsDataURL(file);
        });
    }

    refreshModalImagePreviews() {
        const container = document.getElementById('modal-image-previews');
        if (!container) return;

        const urlInputs = Array.from(document.querySelectorAll('.product-img-url'));
        const images = urlInputs.map(input => input.value.trim()).filter(v => v.length > 0);

        if (images.length === 0) {
            container.innerHTML = `<span style="font-size: 12px; color: var(--text-light); padding: 4px 8px;">No images uploaded yet. Select files below.</span>`;
            return;
        }

        container.innerHTML = '';
        images.forEach((imgSrc, idx) => {
            const thumb = document.createElement('div');
            thumb.style.cssText = 'position: relative; width: 60px; height: 60px; border-radius: 6px; overflow: hidden; border: 1px solid var(--border); background: #fff;';
            thumb.innerHTML = `
                <img src="${imgSrc}" style="width: 100%; height: 100%; object-fit: contain;">
                <button type="button" onclick="app.removeModalImage(${idx})" style="position: absolute; top: 2px; right: 2px; background: rgba(220,38,38,0.85); color: #fff; border: none; border-radius: 50%; width: 18px; height: 18px; font-size: 10px; cursor: pointer; display: flex; align-items: center; justify-content: center;">✕</button>
            `;
            container.appendChild(thumb);
        });
    }

    removeModalImage(index) {
        const urlInputs = Array.from(document.querySelectorAll('.product-img-url'));
        const currentImages = urlInputs.map(input => input.value.trim()).filter(v => v.length > 0);
        currentImages.splice(index, 1);
        urlInputs.forEach((input, idx) => {
            input.value = currentImages[idx] || '';
        });
        this.refreshModalImagePreviews();
    }

    openProductModal(productId = null) {
        const modal = document.getElementById('modal-product-form');
        const title = document.getElementById('product-modal-title');
        const form = document.getElementById('product-details-form');
        form.reset();
        
        const urls = document.querySelectorAll('.product-img-url');
        urls.forEach(u => u.value = '');

        const fileInput = document.getElementById('form-product-file-upload');
        if (fileInput) fileInput.value = '';

        if (productId) {
            title.innerText = "Edit Product Details";
            const products = this.db.getProducts();
            const p = products.find(item => item.id === productId);
            if (p) {
                document.getElementById('form-product-id').value = p.id;
                document.getElementById('form-product-name').value = p.name;
                document.getElementById('form-product-category').value = p.category;
                document.getElementById('form-product-price').value = p.price;
                document.getElementById('form-product-stock').value = p.stock;
                document.getElementById('form-product-spec').value = p.spec || '';
                
                // images list
                if (p.images && Array.isArray(p.images)) {
                    p.images.forEach((imgUrl, idx) => {
                        if (urls[idx]) urls[idx].value = imgUrl;
                    });
                }
            }
        } else {
            title.innerText = "Add New Product";
            document.getElementById('form-product-id').value = '';
        }
        
        this.refreshModalImagePreviews();
        modal.classList.add('active');
    }

    closeProductModal() {
        document.getElementById('modal-product-form').classList.remove('active');
    }

    deleteProduct(id) {
        if (!confirm("Are you sure you want to delete this product?")) return;
        let products = this.db.getProducts();
        products = products.filter(p => p.id !== id);
        this.db.saveProducts(products);
        this.showToast("Product deleted from system inventory.");
        this.renderAdminInventory();
    }

    // ADMIN: Invoicing & Reporting assessment
    handleReportPresetChange() {
        const preset = document.getElementById('report-preset').value;
        const startGroup = document.getElementById('report-start-date-group');
        const endGroup = document.getElementById('report-end-date-group');
        
        if (preset === 'custom') {
            startGroup.style.display = 'block';
            endGroup.style.display = 'block';
        } else {
            startGroup.style.display = 'none';
            endGroup.style.display = 'none';
        }
    }

    generateSalesReport() {
        const preset = document.getElementById('report-preset').value;
        let start = new Date();
        let end = new Date();

        switch(preset) {
            case 'today':
                start.setHours(0,0,0,0);
                end.setHours(23,59,59,999);
                break;
            case 'yesterday':
                start.setDate(start.getDate() - 1);
                start.setHours(0,0,0,0);
                end.setDate(end.getDate() - 1);
                end.setHours(23,59,59,999);
                break;
            case 'this_week':
                const day = start.getDay();
                start.setDate(start.getDate() - day);
                start.setHours(0,0,0,0);
                break;
            case 'this_month':
                start.setDate(1);
                start.setHours(0,0,0,0);
                break;
            case 'this_year':
                start.setMonth(0, 1);
                start.setHours(0,0,0,0);
                break;
            case 'custom':
                const customStart = document.getElementById('report-start-date').value;
                const customEnd = document.getElementById('report-end-date').value;
                if (!customStart || !customEnd) {
                    this.showToast("Select both start and end date.", 'error');
                    return;
                }
                start = new Date(customStart);
                start.setHours(0,0,0,0);
                end = new Date(customEnd);
                end.setHours(23,59,59,999);
                break;
        }

        const orders = this.db.getOrders();
        // filter completed and confirmed orders in range
        const filteredOrders = orders.filter(o => {
            const oDate = new Date(o.date);
            return ['completed', 'confirmed'].includes(o.status) && oDate >= start && oDate <= end;
        });

        // Collect Hire Purchase revenue events
        const hps = this.db.getHP();
        const hpEvents = [];
        hps.forEach(hp => {
            const startDate = new Date(hp.startDate);
            // Deposit event
            if (startDate >= start && startDate <= end) {
                hpEvents.push({
                    date: hp.startDate,
                    id: `${hp.id}-DEP`,
                    clientName: hp.clientName,
                    type: 'HP Deposit',
                    total: hp.deposit
                });
            }
            // Paid installments
            hp.installments.forEach(inst => {
                if (inst.status === 'paid') {
                    const dueDate = new Date(inst.dueDate);
                    if (dueDate >= start && dueDate <= end) {
                        hpEvents.push({
                            date: inst.dueDate,
                            id: `${hp.id}-M${inst.month}`,
                            clientName: hp.clientName,
                            type: `HP Month ${inst.month}`,
                            total: inst.amount
                        });
                    }
                }
            });
        });

        // Merge and sort all transactions by date descending
        const allTransactions = [
            ...filteredOrders.map(o => ({
                date: o.date,
                id: o.id,
                clientName: o.clientName,
                type: o.claimMethod.replace('_', ' ').toUpperCase(),
                total: o.total
            })),
            ...hpEvents
        ];
        allTransactions.sort((a, b) => new Date(b.date) - new Date(a.date));

        const tbody = document.getElementById('report-orders-tbody');
        tbody.innerHTML = '';

        if (allTransactions.length === 0) {
            tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: var(--text-light);">No data generated for this range yet.</td></tr>`;
            document.getElementById('report-stat-revenue').innerText = "GH₵ 0.00";
            document.getElementById('report-stat-count').innerText = 0;
            document.getElementById('report-stat-average').innerText = "GH₵ 0.00";
            return;
        }

        let totalRevenue = 0;

        allTransactions.forEach(t => {
            totalRevenue += t.total;
            const tr = document.createElement('tr');
            const dateStr = new Date(t.date).toLocaleDateString();

            tr.innerHTML = `
                <td>${dateStr}</td>
                <td><strong>${t.id}</strong></td>
                <td>${t.clientName}</td>
                <td>${t.type}</td>
                <td><span class="badge badge-success">COMPLETED</span></td>
                <td style="text-align: right; font-weight:700;">GH₵ ${t.total.toLocaleString(undefined, {minimumFractionDigits: 2})}</td>
            `;
            tbody.appendChild(tr);
        });

        document.getElementById('report-stat-revenue').innerText = `GH₵ ${totalRevenue.toLocaleString(undefined, {minimumFractionDigits: 2})}`;
        document.getElementById('report-stat-count').innerText = allTransactions.length;
        document.getElementById('report-stat-average').innerText = `GH₵ ${(totalRevenue / allTransactions.length).toLocaleString(undefined, {minimumFractionDigits: 2})}`;
        
        document.getElementById('report-subtitle').innerText = `Sales Analysis (${start.toLocaleDateString()} - ${end.toLocaleDateString()})`;
    }

    // PDF generation using jsPDF library
    downloadReportPDF() {
        const { jsPDF } = window.jspdf;
        const doc = new jsPDF();
        
        doc.setFont("helvetica", "bold");
        doc.setFontSize(22);
        doc.text("Kmap Computers - Sales Assessment Report", 14, 20);
        
        doc.setFontSize(12);
        doc.setFont("helvetica", "normal");
        doc.text(`Generated: ${new Date().toLocaleString()}`, 14, 28);
        doc.text(`Authorized by: ${this.currentUser.name} (${this.currentUser.role.toUpperCase()})`, 14, 34);

        const rev = document.getElementById('report-stat-revenue').innerText;
        const count = document.getElementById('report-stat-count').innerText;
        const avg = document.getElementById('report-stat-average').innerText;

        doc.text(`Total Revenue: ${rev}`, 14, 46);
        doc.text(`Completed Orders Count: ${count}`, 14, 52);
        doc.text(`Average Order Size: ${avg}`, 14, 58);

        doc.line(14, 64, 196, 64);
        
        doc.setFont("helvetica", "bold");
        doc.text("Recent Transactions Summary", 14, 72);
        
        // Loop table content
        const rows = document.querySelectorAll('#report-orders-tbody tr');
        let y = 82;
        doc.setFont("helvetica", "normal");
        doc.setFontSize(10);
        
        rows.forEach((row, i) => {
            const text = `${row.cells[0].innerText} | ID: ${row.cells[1].innerText} | ${row.cells[2].innerText} (${row.cells[3].innerText}) | ${row.cells[5].innerText}`;
            doc.text(text, 14, y);
            y += 10;
            if (y > 280) {
                doc.addPage();
                y = 20;
            }
        });

        doc.save(`KMAP_Sales_Report_${Date.now()}.pdf`);
        this.db.addLog(`Downloaded Sales PDF Report`);
    }

    // Backup & Restore Database Functions
    updateBackupStatus() {
        const lastBackup = safeLocalStorage.getItem('kmap_last_backup') || 'Never';
        document.getElementById('backup-timestamp').innerText = `Last backup generated: ${lastBackup}`;
    }

    downloadBackup() {
        const backupData = {
            products: JSON.parse(safeLocalStorage.getItem('kmap_products')),
            users: JSON.parse(safeLocalStorage.getItem('kmap_users')),
            orders: JSON.parse(safeLocalStorage.getItem('kmap_orders')),
            logs: JSON.parse(safeLocalStorage.getItem('kmap_logs'))
        };

        const str = JSON.stringify(backupData, null, 4);
        const dataUri = 'data:application/json;charset=utf-8,'+ encodeURIComponent(str);
        
        const link = document.createElement('a');
        link.setAttribute('href', dataUri);
        link.setAttribute('download', `kmap_backup_${new Date().toISOString().split('T')[0]}.json`);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);

        const nowStr = new Date().toLocaleString();
        safeLocalStorage.setItem('kmap_last_backup', nowStr);
        this.updateBackupStatus();
        this.db.addLog(`Daily Backup JSON file exported.`);
        this.showToast("Backup exported successfully.");
    }

    restoreBackup(input) {
        const file = input.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const parsed = JSON.parse(e.target.result);
                if (parsed.products && parsed.users && parsed.orders) {
                    safeLocalStorage.setItem('kmap_products', JSON.stringify(parsed.products));
                    safeLocalStorage.setItem('kmap_users', JSON.stringify(parsed.users));
                    safeLocalStorage.setItem('kmap_orders', JSON.stringify(parsed.orders));
                    if (parsed.logs) safeLocalStorage.setItem('kmap_logs', JSON.stringify(parsed.logs));
                    
                    this.showToast("Database restored successfully!");
                    this.initDatabase();
                    this.switchView('admin-dashboard');
                } else {
                    this.showToast("Invalid backup file schema.", 'error');
                }
            } catch (err) {
                this.showToast("Failed to parse file.", 'error');
            }
        };
        reader.readAsText(file);
    }

    // Super Admin: List all admin accounts
    renderStaffList() {
        if (this.currentUser.role === 'superadmin') {
            document.getElementById('superadmin-user-card').style.display = 'block';
        } else {
            document.getElementById('superadmin-user-card').style.display = 'none';
            return;
        }

        const tbody = document.getElementById('staff-list-tbody');
        tbody.innerHTML = '';

        const users = this.db.getUsers().filter(u => u.role !== 'client');
        users.forEach(u => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td><strong>${u.username}</strong></td>
                <td><span class="badge badge-primary">${u.role.toUpperCase()}</span></td>
                <td>
                    <button class="btn btn-danger" style="padding: 4px 8px; font-size: 11px;" 
                        onclick="app.deleteStaff('${u.username}')" ${u.username === 'superadmin' ? 'disabled' : ''}>
                        Remove
                    </button>
                </td>
            `;
            tbody.appendChild(tr);
        });
    }

    deleteStaff(username) {
        if (!confirm(`Are you sure you want to remove staff account: ${username}?`)) return;
        let users = this.db.getUsers();
        users = users.filter(u => u.username !== username);
        this.db.saveUsers(users);
        this.db.addLog(`Removed staff user: ${username}`);
        this.showToast(`User ${username} removed.`);
        this.renderStaffList();
    }

    // Real-time toast alerts
    showToast(msg, type = 'success') {
        const container = document.getElementById('toast-container');
        const toast = document.createElement('div');
        toast.className = 'toast';
        if (type === 'error') toast.style.borderLeftColor = 'var(--error)';
        
        toast.innerHTML = `
            <i class="fa-solid ${type === 'error' ? 'fa-triangle-exclamation' : 'fa-circle-check'}" 
               style="color: ${type === 'error' ? 'var(--error)' : 'var(--accent)'};"></i>
            <span>${msg}</span>
        `;
        container.appendChild(toast);
        
        setTimeout(() => {
            toast.remove();
        }, 4000);
    }

    // ==========================================
    // HIRE PURCHASE SYSTEM METHODS
    // ==========================================

    // Open create HP modal
    openHPModal() {
        document.getElementById('modal-hp-form').classList.add('active');
        
        // Populate products select list
        const select = document.getElementById('form-hp-product-select');
        select.innerHTML = '';
        
        const products = this.db.getProducts();
        products.forEach(p => {
            const opt = document.createElement('option');
            opt.value = p.id;
            opt.innerText = `${p.name} (GH₵ ${p.price.toLocaleString()})`;
            select.appendChild(opt);
        });
        
        // Add custom machine option
        const optCustom = document.createElement('option');
        optCustom.value = 'custom';
        optCustom.innerText = '-- Type Custom Item / Machine --';
        select.appendChild(optCustom);
        
        // Set default date to today
        document.getElementById('form-hp-date').value = new Date().toISOString().substring(0, 10);
        
        // Reset custom input
        document.getElementById('form-hp-product-custom').style.display = 'none';
        document.getElementById('form-hp-product-custom').required = false;
        
        // Trigger default product change to auto-fill price
        this.handleHPProductChange();
    }

    closeHPModal() {
        document.getElementById('modal-hp-form').classList.remove('active');
        document.getElementById('hp-details-form').reset();
    }

    handleHPProductChange() {
        const select = document.getElementById('form-hp-product-select');
        const customInput = document.getElementById('form-hp-product-custom');
        const priceInput = document.getElementById('form-hp-price');
        
        if (select.value === 'custom') {
            customInput.style.display = 'block';
            customInput.required = true;
            customInput.value = '';
            priceInput.value = '';
        } else {
            customInput.style.display = 'none';
            customInput.required = false;
            
            const products = this.db.getProducts();
            const product = products.find(p => p.id === select.value);
            if (product) {
                priceInput.value = this.getDiscountedPrice(product);
            }
        }
    }

    // Save HP Form Submit
    saveNewHP(clientName, phone, machine, price, deposit, months, startDateStr) {
        const priceVal = parseFloat(price);
        const depositVal = parseFloat(deposit);
        const monthsVal = parseInt(months);
        
        if (depositVal >= priceVal) {
            this.showToast("Deposit cannot be equal to or larger than price.", 'error');
            return;
        }

        const remaining = priceVal - depositVal;
        const monthlyAmount = parseFloat((remaining / monthsVal).toFixed(2));
        
        const start = new Date(startDateStr);
        const installments = [];
        for (let i = 1; i <= monthsVal; i++) {
            const dueDate = new Date(start.getTime());
            dueDate.setMonth(dueDate.getMonth() + i);
            installments.push({
                month: i,
                dueDate: dueDate.toISOString(),
                amount: monthlyAmount,
                status: 'pending'
            });
        }

        const hps = this.db.getHP();
        const newId = 'HP-' + String(hps.length + 1).padStart(3, '0');
        const newRecord = {
            id: newId,
            clientName,
            phone,
            machine,
            price: priceVal,
            deposit: depositVal,
            months: monthsVal,
            startDate: start.toISOString(),
            installments,
            status: 'active'
        };

        hps.push(newRecord);
        this.db.saveHP(hps);
        this.db.addLog(`Created new Hire Purchase Agreement ${newId} for client ${clientName}.`);
        this.showToast(`Hire Purchase agreement created!`);
        this.closeHPModal();
        this.renderHPList();
    }

    // Render HP list
    renderHPList() {
        const filterStatus = document.getElementById('admin-hp-status-filter').value;
        const query = document.getElementById('admin-hp-search').value.toLowerCase();
        
        const hps = this.db.getHP();
        
        // Dynamically update status of hps first
        hps.forEach(hp => {
            const allPaid = hp.installments.every(inst => inst.status === 'paid');
            if (allPaid) {
                hp.status = 'completed';
            } else {
                // Check if any pending installment is overdue
                const now = new Date();
                const hasOverdue = hp.installments.some(inst => inst.status === 'pending' && new Date(inst.dueDate) < now);
                if (hasOverdue) {
                    hp.status = 'overdue';
                } else {
                    hp.status = 'active';
                }
            }
        });
        
        // Save dynamically updated statuses back
        this.db.saveHP(hps);

        // Stats calculation
        let activeCount = 0;
        let completedCount = 0;
        let outstandingBalance = 0;
        let nearOverdueAlerts = 0;
        const now = new Date();
        const threeDaysFromNow = new Date(now.getTime() + 3600000 * 24 * 3);

        hps.forEach(hp => {
            if (hp.status === 'completed') {
                completedCount++;
            } else {
                activeCount++;
                // Outstanding balance is total price minus deposit minus paid installments
                const paidAmt = hp.installments.filter(inst => inst.status === 'paid').reduce((sum, inst) => sum + inst.amount, 0);
                outstandingBalance += (hp.price - hp.deposit - paidAmt);
                
                // Count near due (due in 3 days or less) or overdue
                hp.installments.forEach(inst => {
                    if (inst.status === 'pending') {
                        const due = new Date(inst.dueDate);
                        if (due <= threeDaysFromNow) {
                            nearOverdueAlerts++;
                        }
                    }
                });
            }
        });

        document.getElementById('hp-stat-active').innerText = activeCount;
        document.getElementById('hp-stat-balance').innerText = `GH₵ ${outstandingBalance.toLocaleString(undefined, {minimumFractionDigits: 2})}`;
        document.getElementById('hp-stat-alerts').innerText = nearOverdueAlerts;
        document.getElementById('hp-stat-completed').innerText = completedCount;
        
        const tbody = document.getElementById('admin-hp-tbody');
        if (!tbody) return;
        tbody.innerHTML = '';

        const filtered = hps.filter(hp => {
            const matchesSearch = hp.clientName.toLowerCase().includes(query) || 
                                  hp.phone.toLowerCase().includes(query) || 
                                  hp.machine.toLowerCase().includes(query);
            const matchesFilter = filterStatus === 'all' || hp.status === filterStatus;
            return matchesSearch && matchesFilter;
        });

        if (filtered.length === 0) {
            tbody.innerHTML = `<tr><td colspan="9" style="text-align: center; color: var(--text-light); padding: 20px;">No Hire Purchase records found.</td></tr>`;
            return;
        }

        filtered.forEach(hp => {
            const tr = document.createElement('tr');
            
            // Calculate next due installment
            const nextDueInst = hp.installments.find(inst => inst.status === 'pending');
            let nextDueStr = 'N/A';
            let nextDueStyle = '';
            
            if (nextDueInst) {
                const dueDate = new Date(nextDueInst.dueDate);
                nextDueStr = dueDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
                
                if (dueDate < now) {
                    nextDueStyle = 'color: var(--error); font-weight: 700;';
                } else if (dueDate <= threeDaysFromNow) {
                    nextDueStyle = 'color: var(--warning); font-weight: 700;';
                }
            }

            const paidCount = hp.installments.filter(inst => inst.status === 'paid').length;
            const totalInst = hp.installments.length;
            
            const unpaidBalance = hp.status === 'completed' ? 0 : (hp.price - hp.deposit - hp.installments.filter(inst => inst.status === 'paid').reduce((sum, inst) => sum + inst.amount, 0));
            
            let statusBadge = '';
            if (hp.status === 'completed') statusBadge = '<span class="badge badge-success">Completed</span>';
            else if (hp.status === 'overdue') statusBadge = '<span class="badge" style="background: rgba(217, 48, 37, 0.1); color: var(--error); font-weight: 600; padding: 4px 8px;">Overdue</span>';
            else statusBadge = '<span class="badge badge-primary">Active</span>';

            tr.innerHTML = `
                <td>
                    <strong>${hp.clientName}</strong><br>
                    <span style="font-size: 12px; color: var(--text-light);"><i class="fa-solid fa-phone"></i> ${hp.phone}</span>
                </td>
                <td><strong>${hp.machine}</strong></td>
                <td>GH₵ ${hp.price.toLocaleString(undefined, {minimumFractionDigits: 2})}</td>
                <td>GH₵ ${hp.deposit.toLocaleString(undefined, {minimumFractionDigits: 2})}</td>
                <td style="font-weight: 600;">GH₵ ${unpaidBalance.toLocaleString(undefined, {minimumFractionDigits: 2})}</td>
                <td><strong>${paidCount} / ${totalInst}</strong></td>
                <td style="${nextDueStyle}">${nextDueStr}</td>
                <td>${statusBadge}</td>
                <td>
                    <div style="display: flex; gap: 8px;">
                        <button class="btn btn-outline" style="padding: 6px 10px; font-size: 12px;" onclick="app.viewHPDetails('${hp.id}')">
                            <i class="fa-solid fa-receipt"></i> Details
                        </button>
                        <button class="btn btn-outline" style="padding: 6px 10px; font-size: 12px; color: var(--error); border-color: rgba(217,48,37,0.3);" onclick="app.deleteHP('${hp.id}')">
                            <i class="fa-solid fa-trash"></i>
                        </button>
                    </div>
                </td>
            `;
            tbody.appendChild(tr);
        });
    }

    // View HP Details Modal
    viewHPDetails(hpId) {
        const hps = this.db.getHP();
        const hp = hps.find(item => item.id === hpId);
        if (!hp) return;

        this.activeHPId = hpId;
        document.getElementById('modal-hp-details').classList.add('active');

        // Render top summary in details view
        const unpaid = hp.price - hp.deposit - hp.installments.filter(inst => inst.status === 'paid').reduce((sum, inst) => sum + inst.amount, 0);
        document.getElementById('hp-details-info').innerHTML = `
            <div><strong>Client:</strong> ${hp.clientName} (${hp.phone})</div>
            <div><strong>Item:</strong> ${hp.machine}</div>
            <div><strong>Total Price:</strong> GH₵ ${hp.price.toLocaleString(undefined, {minimumFractionDigits: 2})}</div>
            <div><strong>Deposit:</strong> GH₵ ${hp.deposit.toLocaleString(undefined, {minimumFractionDigits: 2})}</div>
            <div><strong>Outstanding:</strong> GH₵ ${unpaid.toLocaleString(undefined, {minimumFractionDigits: 2})}</div>
            <div><strong>Agreement Date:</strong> ${new Date(hp.startDate).toLocaleDateString()}</div>
        `;

        // Render installments list
        this.renderHPDetailsInstallments(hp);
    }

    renderHPDetailsInstallments(hp) {
        const tbody = document.getElementById('hp-details-installments-tbody');
        tbody.innerHTML = '';

        const now = new Date();
        const threeDaysFromNow = new Date(now.getTime() + 3600000 * 24 * 3);

        hp.installments.forEach((inst, index) => {
            const tr = document.createElement('tr');
            const dueDate = new Date(inst.dueDate);
            const dueStr = dueDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
            
            let statusText = '';
            let dueStyle = '';
            
            if (inst.status === 'paid') {
                statusText = '<span class="badge badge-success">Paid</span>';
            } else {
                if (dueDate < now) {
                    statusText = '<span class="badge" style="background: rgba(217, 48, 37, 0.1); color: var(--error); font-weight: 700; padding: 4px 8px;">Overdue</span>';
                    dueStyle = 'color: var(--error); font-weight: 700;';
                } else if (dueDate <= threeDaysFromNow) {
                    statusText = '<span class="badge" style="background: rgba(244, 180, 0, 0.1); color: var(--warning); font-weight: 700; padding: 4px 8px;">Near Due</span>';
                    dueStyle = 'color: var(--warning); font-weight: 700;';
                } else {
                    statusText = '<span class="badge badge-primary" style="background: rgba(218, 145, 0, 0.1); color: var(--primary);">Pending</span>';
                }
            }

            const actionBtn = inst.status === 'paid'
                ? `<button class="btn btn-outline" style="padding: 6px 12px; font-size: 12px; font-weight: bold;" onclick="app.toggleHPInstallmentStatus('${hp.id}', ${index})">Mark Unpaid</button>`
                : `<button class="btn" style="padding: 8px 16px; font-size: 12px; font-weight: bold; background-color: var(--success); color: white; border: none; box-shadow: 0 2px 4px rgba(0,0,0,0.15); display: inline-flex; align-items: center; gap: 4px;" onclick="app.toggleHPInstallmentStatus('${hp.id}', ${index})"><i class="fa-solid fa-check"></i> Mark Paid</button>`;

            tr.innerHTML = `
                <td><strong>Month ${inst.month}</strong></td>
                <td style="${dueStyle}">${dueStr}</td>
                <td>GH₵ ${inst.amount.toLocaleString(undefined, {minimumFractionDigits: 2})}</td>
                <td>${statusText}</td>
                <td>${actionBtn}</td>
            `;
            tbody.appendChild(tr);
        });
    }

    toggleHPInstallmentStatus(hpId, instIndex) {
        const hps = this.db.getHP();
        const hp = hps.find(item => item.id === hpId);
        if (!hp) return;

        const inst = hp.installments[instIndex];
        if (inst.status === 'paid') {
            inst.status = 'pending';
            this.showToast(`Installment ${inst.month} marked as unpaid.`);
        } else {
            inst.status = 'paid';
            this.showToast(`Installment ${inst.month} marked as PAID.`);
        }

        // recalculate overall status
        const allPaid = hp.installments.every(i => i.status === 'paid');
        if (allPaid) {
            hp.status = 'completed';
            this.showToast(`🎉 Hire Purchase Agreement ${hp.id} has been fully paid and completed!`);
        } else {
            const now = new Date();
            const hasOverdue = hp.installments.some(i => i.status === 'pending' && new Date(i.dueDate) < now);
            if (hasOverdue) {
                hp.status = 'overdue';
            } else {
                hp.status = 'active';
            }
        }

        this.db.saveHP(hps);
        this.renderHPDetailsInstallments(hp);
        this.renderHPList();
    }

    closeHPDetailsModal() {
        document.getElementById('modal-hp-details').classList.remove('active');
        this.activeHPId = null;
    }

    // Delete HP record
    deleteHP(hpId) {
        if (!confirm(`Are you sure you want to permanently delete Hire Purchase Agreement ${hpId}?`)) return;
        let hps = this.db.getHP();
        hps = hps.filter(item => item.id !== hpId);
        this.db.saveHP(hps);
        this.db.addLog(`Deleted Hire Purchase agreement ${hpId}.`);
        this.showToast(`Agreement deleted successfully.`);
        this.renderHPList();
    }

    // Toast alert on login / navigation for near-due hire purchases
    checkHPNearDueAlerts() {
        const hps = this.db.getHP();
        const now = new Date();
        const threeDaysFromNow = new Date(now.getTime() + 3600000 * 24 * 3);
        
        let overdueCount = 0;
        let nearDueCount = 0;
        
        hps.forEach(hp => {
            if (hp.status !== 'completed') {
                hp.installments.forEach(inst => {
                    if (inst.status === 'pending') {
                        const due = new Date(inst.dueDate);
                        if (due < now) {
                            overdueCount++;
                        } else if (due <= threeDaysFromNow) {
                            nearDueCount++;
                        }
                    }
                });
            }
        });
        
        if (overdueCount > 0) {
            this.showToast(`⚠️ Alert: You have ${overdueCount} overdue installment payment(s)!`, 'error');
        }
        if (nearDueCount > 0) {
            this.showToast(`🔔 Attention: ${nearDueCount} installment payment(s) are due within 3 days.`, 'success');
        }
    }

    openUserProfileModal() {
        if (!this.currentUser) return;
        
        document.getElementById('profile-modal-name').innerText = this.currentUser.name;
        document.getElementById('profile-modal-username').innerText = this.currentUser.username;
        document.getElementById('profile-modal-avatar').innerText = this.currentUser.name.charAt(0).toUpperCase();

        document.getElementById('modal-user-profile').classList.add('active');
    }

    closeUserProfileModal() {
        document.getElementById('modal-user-profile').classList.remove('active');
    }

    openChangePasswordFromProfile() {
        this.closeUserProfileModal();
        this.openChangePasswordModal();
    }

    openChangePasswordModal() {
        if (this.currentUser.role === 'guest') {
            this.showToast("Guest account cannot change password.", 'error');
            return;
        }
        document.getElementById('modal-change-password').classList.add('active');
    }

    closeChangePasswordModal() {
        document.getElementById('modal-change-password').classList.remove('active');
        document.getElementById('change-password-form').reset();
    }

    changePassword(currentPw, newPw, confirmPw) {
        if (newPw !== confirmPw) {
            this.showToast("New passwords do not match.", 'error');
            return;
        }
        
        if (currentPw !== this.currentUser.password) {
            this.showToast("Incorrect current password.", 'error');
            return;
        }

        const users = this.db.getUsers();
        const user = users.find(u => u.username === this.currentUser.username);
        
        if (user) {
            user.password = newPw;
            this.currentUser.password = newPw;
            this.db.saveUsers(users);
            this.db.addLog(`Changed password for user ${user.username}`);
            this.showToast("Password updated successfully!");
            this.closeChangePasswordModal();
        } else {
            this.showToast("User session error.", 'error');
        }
    }

    goBack() {
        if (this.viewHistoryPointer > 0) {
            this.isNavigatingHistory = true;
            this.viewHistoryPointer--;
            this.switchView(this.viewHistory[this.viewHistoryPointer]);
            this.isNavigatingHistory = false;
            this.updateNavHistoryButtons();
        }
    }

    goForward() {
        if (this.viewHistoryPointer < this.viewHistory.length - 1) {
            this.isNavigatingHistory = true;
            this.viewHistoryPointer++;
            this.switchView(this.viewHistory[this.viewHistoryPointer]);
            this.isNavigatingHistory = false;
            this.updateNavHistoryButtons();
        }
    }

    updateNavHistoryButtons() {
        const backBtn = document.getElementById('header-back-btn');
        const forwardBtn = document.getElementById('header-forward-btn');
        if (backBtn) {
            backBtn.disabled = this.viewHistoryPointer <= 0;
            backBtn.style.opacity = this.viewHistoryPointer <= 0 ? '0.4' : '1';
            backBtn.style.cursor = this.viewHistoryPointer <= 0 ? 'not-allowed' : 'pointer';
        }
        if (forwardBtn) {
            forwardBtn.disabled = this.viewHistoryPointer >= this.viewHistory.length - 1;
            forwardBtn.style.opacity = this.viewHistoryPointer >= this.viewHistory.length - 1 ? '0.4' : '1';
            forwardBtn.style.cursor = this.viewHistoryPointer >= this.viewHistory.length - 1 ? 'not-allowed' : 'pointer';
        }
    }

    togglePasswordVisibility(inputId, iconId) {
        const input = document.getElementById(inputId);
        const icon = document.getElementById(iconId);
        if (input.type === 'password') {
            input.type = 'text';
            icon.classList.remove('fa-eye');
            icon.classList.add('fa-eye-slash');
        } else {
            input.type = 'password';
            icon.classList.remove('fa-eye-slash');
            icon.classList.add('fa-eye');
        }
    }

    logout(preserveCart = false) {
        this.currentUser = null;
        if (this.simInterval) clearInterval(this.simInterval);
        if (!preserveCart) this.cart = [];
        safeLocalStorage.removeItem('kmap_current_user');
        
        document.getElementById('app-root').style.display = 'none';
        document.getElementById('login-screen').style.display = 'flex';
        document.getElementById('login-form').reset();
        document.getElementById('signup-form').reset();
        document.getElementById('login-error-msg').style.display = 'none';
        
        // Show login form by default on returning
        document.getElementById('signup-form').style.display = 'none';
        document.getElementById('login-form').style.display = 'block';
    }
}

// Instantiate App
const app = new KmapStoreApp();
window.app = app;
