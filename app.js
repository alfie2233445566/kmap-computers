// Kmap Computers Application Engine
let storage = {};

const safeLocalStorage = {
    getItem: (key) => {
        try {
            return window.localStorage.getItem(key) || storage[key] || null;
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
        const watchedKeys = ['kmap_products', 'kmap_users', 'kmap_orders', 'kmap_logs', 'kmap_promos', 'kmap_hire_purchase', 'kmap_featured_laptops', 'kmap_catalog_version'];
        if (!skipSync && watchedKeys.includes(key)) {
            window.lastLocalSaveTimestamp = window.lastLocalSaveTimestamp || {};
            window.lastLocalSaveTimestamp[key] = Date.now();
            try {
                window.kvSyncQueue[key] = JSON.parse(val);
                if (window.kvSyncTimeout) clearTimeout(window.kvSyncTimeout);
                window.kvSyncTimeout = setTimeout(triggerKVSync, 300); // Fast debounce uploads
            } catch (e) { }
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

const getApiBaseUrl = (path) => {
    try {
        const custom = safeLocalStorage.getItem('kmap_cloud_sync_url');
        if (custom && path === '/api/sync') return custom;
    } catch (e) { }

    if (typeof window !== 'undefined' && window.location) {
        if (window.location.protocol === 'file:' ||
            window.location.hostname === 'localhost' ||
            window.location.hostname === '127.0.0.1' ||
            !window.location.hostname) {
            return `https://kmap-computers.vercel.app${path}`;
        }
    }
    return path;
};

const getSyncApiUrl = () => getApiBaseUrl('/api/sync');
const getAuthApiUrl = () => getApiBaseUrl('/api/auth');
const getOtpApiUrl = () => getApiBaseUrl('/api/send-otp');

// Queue for uploading to Vercel KV
window.kvSyncQueue = {};
window.kvSyncTimeout = null;

const triggerKVSync = () => {
    if (Object.keys(window.kvSyncQueue).length === 0) return;

    const payload = { updates: { ...window.kvSyncQueue } };
    window.kvSyncQueue = {}; // Clear queue

    const headers = { 'Content-Type': 'application/json' };
    const token = safeLocalStorage.getItem('kmap_auth_token');
    if (token) {
        headers['Authorization'] = `Bearer ${token}`;
    }

    fetch(getSyncApiUrl(), {
        method: 'POST',
        headers,
        body: JSON.stringify(payload)
    })
        .then(async (res) => {
            if (!res.ok) {
                const errData = await res.json().catch(() => ({}));
                console.error('KV Sync Failed:', res.status, errData);
                if (window.app && typeof window.app.showToast === 'function') {
                    if (res.status === 401) {
                        window.app.showToast('🔒 Cloud write restricted: Admin login session required.', 'error');
                    } else if (res.status === 413) {
                        window.app.showToast('⚠️ Cloud sync failed: Photos payload too large for KV storage!', 'error');
                    } else if (res.status === 500) {
                        window.app.showToast(`⚠️ Cloud sync failed: ${errData.error || 'Server error'}`, 'error');
                    }
                }
            } else {
                console.log('✓ KV Sync successful');
            }
        })
        .catch(err => console.error('KV Sync Network Error:', err));
};

class KmapStoreApp {
    constructor() {
        this.db = null;
        this.currentUser = null;
        this.activeView = 'landing-page';
        this.activeCategory = 'All';
        this.cart = [];
        this.favorites = [];
        this.salesChart = null;
        this.inspectBackView = null;

        // History Navigation
        this.viewHistory = [];
        this.viewHistoryPointer = -1;
        this.isNavigatingHistory = false;

        this.initDatabase();
        this.bindEvents();
        this.initSession();
        setTimeout(() => this.initGoogleAuth(), 600);

        // Track known order IDs and statuses for reliable real-time notifications
        this.knownOrdersMap = new Map();
        try {
            const initialOrders = JSON.parse(safeLocalStorage.getItem('kmap_orders') || '[]');
            initialOrders.forEach(o => this.knownOrdersMap.set(o.id, o.status));
        } catch (e) { }

        // Start polling for Vercel KV updates
        setInterval(() => this.syncDownstream(), 5000);
        this.syncDownstream();
    }

    async syncDownstream() {
        const indicator = document.getElementById('sync-status-indicator');
        const syncUrl = getSyncApiUrl();
        try {
            const headers = {};
            const token = safeLocalStorage.getItem('kmap_auth_token');
            if (token) headers['Authorization'] = `Bearer ${token}`;
            const res = await fetch(syncUrl, { headers });
            const isAdmin = this.currentUser && ['admin', 'superadmin'].includes(this.currentUser.role);
            if (res.ok) {
                if (indicator) {
                    indicator.innerHTML = `<span style="display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: #059669;"></span> Cloud Sync Live`;
                    indicator.style.background = 'rgba(16,185,129,0.1)';
                    indicator.style.color = '#059669';
                    indicator.title = `Connected to Upstash Redis (${syncUrl})`;
                    indicator.style.display = isAdmin ? 'inline-flex' : 'none';
                }
                const data = await res.json();

                // Auto-seed cloud if kmap_products is empty in cloud storage
                if (!data.kmap_products || (Array.isArray(data.kmap_products) && data.kmap_products.length === 0)) {
                    const localProducts = this.db.getProducts();
                    if (localProducts && localProducts.length > 0) {
                        this.forceCloudSyncAll(true);
                    }
                }

                let updated = false;
                for (const key of Object.keys(data)) {
                    if (data[key] !== null && data[key] !== undefined) {
                        // Filter out legacy test data from incoming cloud sync if still present in KV
                        if (key === 'kmap_orders' && Array.isArray(data[key])) {
                            data[key] = data[key].filter(o => o.id !== 'ORD-8932' && o.id !== 'ORD-7612' && o.clientName !== 'Kwame Mensah' && o.clientName !== 'Ama Serwaa');
                        }
                        if (key === 'kmap_hire_purchase' && Array.isArray(data[key])) {
                            data[key] = data[key].filter(h => h.id !== 'HP-001' && h.clientName !== 'Kwame Mensah');
                        }
                        if (key === 'kmap_users' && Array.isArray(data[key])) {
                            data[key] = data[key].filter(u => u.username !== '0241234567' && u.name !== 'Kwame Mensah');
                        }
                        if (key === 'kmap_products' && Array.isArray(data[key])) {
                            const pCase = data[key].find(p => p.id === 'PROD-ACC-001');
                            if (pCase && pCase.category !== 'Accessories') {
                                pCase.category = 'Accessories';
                            }
                            if (this.defaultProductsList && Array.isArray(this.defaultProductsList)) {
                                this.defaultProductsList.forEach(defProd => {
                                    const ex = data[key].find(p => p.id === defProd.id);
                                    if (!ex) {
                                        data[key].push(defProd);
                                    } else {
                                        if (defProd.priceDisplay === undefined && ex.priceDisplay) {
                                            delete ex.priceDisplay;
                                        }
                                        if (defProd.id.startsWith('PROD-CHG-MAC')) {
                                            delete ex.priceDisplay;
                                            ex.price = defProd.price;
                                        }
                                        if (defProd.name && ex.name !== defProd.name) {
                                            ex.name = defProd.name;
                                        }
                                    }
                                });
                                data[key].forEach(p => {
                                    if (p.name && p.name.toLowerCase().includes('replacement') && p.category !== 'Parts') {
                                        p.category = 'Parts';
                                    }
                                });
                                data[key] = this.sortProductList(data[key]);
                            }
                        }

                        let cloudVal = typeof data[key] === 'string' ? data[key] : JSON.stringify(data[key]);
                        const localVal = safeLocalStorage.getItem(key);
                        if (cloudVal !== localVal) {
                            // If local user recently saved changes to this key (within last 12s), do not overwrite with stale cloud data
                            const lastLocalSave = window.lastLocalSaveTimestamp && window.lastLocalSaveTimestamp[key];
                            if (lastLocalSave && (Date.now() - lastLocalSave < 12000)) {
                                continue;
                            }
                            // Update silently to prevent triggering loop
                            safeLocalStorage.setItem(key, cloudVal, true);
                            updated = true;
                        }
                    }
                }
                if (updated) {
                    if (data.kmap_orders && Array.isArray(data.kmap_orders)) {
                        this.checkOrderNotifications(data.kmap_orders);
                    }

                    // Update active views immediately
                    this.renderClientCatalog();
                    this.renderPromotions();
                    this.renderCart();
                    this.renderAdminInventory();
                    this.renderAdminOverview();
                    this.renderClientOrders();
                    this.renderAdminOrders();
                    this.updateFeaturedPrices();

                    // Trigger cross-tab sync to refresh other local tabs
                    window.dispatchEvent(new StorageEvent('storage', { key: 'kmap_orders' }));
                    window.dispatchEvent(new StorageEvent('storage', { key: 'kmap_products' }));
                }
            } else {
                const errData = await res.json().catch(() => ({}));
                if (indicator) {
                    indicator.innerHTML = `<span style="display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: #f59e0b;"></span> Sync Offline`;
                    indicator.style.background = 'rgba(245,158,11,0.1)';
                    indicator.style.color = '#d97706';
                    indicator.title = errData.error || `HTTP ${res.status}: Cloud database not connected`;
                    indicator.style.display = isAdmin ? 'inline-flex' : 'none';
                }
            }
        } catch (e) {
            const isAdmin = this.currentUser && ['admin', 'superadmin'].includes(this.currentUser.role);
            if (indicator) {
                indicator.innerHTML = `<span style="display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: #94a3b8;"></span> Local Cache`;
                indicator.style.background = 'rgba(148,163,184,0.1)';
                indicator.style.color = '#64748b';
                indicator.title = 'Offline / Local cache only';
                indicator.style.display = isAdmin ? 'inline-flex' : 'none';
            }
        }
    }

    async forceCloudSyncAll(silent = false) {
        const products = this.db.getProducts();
        const syncUrl = getSyncApiUrl();
        const isAdmin = this.currentUser && ['admin', 'superadmin'].includes(this.currentUser.role);
        try {
            const res = await fetch(syncUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    updates: {
                        kmap_products: products,
                        kmap_users: this.db.getUsers(),
                        kmap_promos: this.db.getPromos(),
                        kmap_hire_purchase: this.db.getHP(),
                        kmap_featured_laptops: this.db.getFeaturedLaptops(),
                        kmap_catalog_version: 'v4.6_20261008'
                    }
                })
            });
            if (res.ok) {
                const indicator = document.getElementById('sync-status-indicator');
                if (indicator) {
                    indicator.innerHTML = `<span style="display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: #059669;"></span> Cloud Sync Live`;
                    indicator.style.background = 'rgba(16,185,129,0.1)';
                    indicator.style.color = '#059669';
                    indicator.title = `Connected to Upstash Redis (${syncUrl})`;
                    indicator.style.display = isAdmin ? 'inline-flex' : 'none';
                }
            } else {
                const errData = await res.json().catch(() => ({}));
                if (!silent) this.showToast(`⚠️ Sync failed: ${errData.error || res.statusText}`, 'error');
            }
        } catch (e) {
            console.error('Cloud Sync Error:', e);
            if (!silent) this.showToast(`⚠️ Network error: ${e.message || 'Cannot reach cloud endpoint'}`, 'error');
        }
    }

    sortProductList(products) {
        if (!Array.isArray(products) || products.length === 0) return products;

        const macOrderMap = {
            'PROD-CHG-MAC01': 1, // MagSafe 1 (45W)
            'PROD-CHG-MAC03': 2, // MagSafe 1 (60W)
            'PROD-CHG-MAC04': 3, // MagSafe 1 (85W)
            'PROD-CHG-MAC02': 4, // MagSafe 2 (45W)
            'PROD-CHG-MAC05': 5, // MagSafe 2 (60W)
            'PROD-CHG-MAC06': 6  // MagSafe 2 (85W)
        };

        const isMacBookCharger = (p) => {
            if (!p) return false;
            if (p.id && (p.id in macOrderMap || p.id.startsWith('PROD-CHG-MAC'))) return true;
            const name = (p.name || '').toLowerCase();
            return name.includes('macbook') && (name.includes('charger') || name.includes('magsafe') || name.includes('adapter'));
        };

        const getMacWeight = (p) => {
            if (p.id && macOrderMap[p.id]) return macOrderMap[p.id];
            const name = (p.name || '').toLowerCase();
            const spec = (p.spec || '').toLowerCase();
            const text = name + ' ' + spec;
            let safe = (text.includes('safe 2') || text.includes('safe2')) ? 2 : 1;
            let watt = 45;
            if (text.includes('85w')) watt = 85;
            else if (text.includes('60w')) watt = 60;
            else if (text.includes('45w')) watt = 45;
            return (safe * 10) + (watt === 85 ? 3 : watt === 60 ? 2 : 1);
        };

        const defOrder = new Map((this.defaultProductsList || []).map((p, idx) => [p.id, idx]));

        return [...products].sort((a, b) => {
            const isMacA = isMacBookCharger(a);
            const isMacB = isMacBookCharger(b);

            // If both are MacBook chargers, sort strictly so they follow each other in order
            if (isMacA && isMacB) {
                return getMacWeight(a) - getMacWeight(b);
            }

            // If one is MacBook and the other is in defaultProducts, anchor by MagSafe 1 45W position
            if (isMacA && !isMacB && defOrder.has(b.id)) {
                const macAnchor = defOrder.has('PROD-CHG-MAC01') ? defOrder.get('PROD-CHG-MAC01') : 40;
                return macAnchor - defOrder.get(b.id);
            }
            if (!isMacA && isMacB && defOrder.has(a.id)) {
                const macAnchor = defOrder.has('PROD-CHG-MAC01') ? defOrder.get('PROD-CHG-MAC01') : 40;
                return defOrder.get(a.id) - macAnchor;
            }

            // Both in default list
            if (defOrder.has(a.id) && defOrder.has(b.id)) {
                return defOrder.get(a.id) - defOrder.get(b.id);
            }

            const orderA = defOrder.has(a.id) ? defOrder.get(a.id) : 9999;
            const orderB = defOrder.has(b.id) ? defOrder.get(b.id) : 9999;
            return orderA - orderB;
        });
    }

    loadCart() {
        try {
            const saved = safeLocalStorage.getItem('kmap_cart');
            this.cart = saved ? JSON.parse(saved) : [];
        } catch (e) {
            this.cart = [];
        }
        this.updateCartBadges();
    }

    saveCart() {
        try {
            safeLocalStorage.setItem('kmap_cart', JSON.stringify(this.cart));
        } catch (e) { }
        this.updateCartBadges();
    }

    loadFavorites() {
        try {
            const saved = safeLocalStorage.getItem('kmap_favorites');
            this.favorites = saved ? JSON.parse(saved) : [];
        } catch (e) {
            this.favorites = [];
        }
        this.updateFavoritesBadges();
        return this.favorites;
    }

    saveFavorites() {
        try {
            safeLocalStorage.setItem('kmap_favorites', JSON.stringify(this.favorites));
        } catch (e) { }
        this.updateFavoritesBadges();
    }

    isFavorite(productId) {
        return Array.isArray(this.favorites) && this.favorites.includes(productId);
    }

    toggleFavorite(productId) {
        if (!Array.isArray(this.favorites)) this.favorites = [];
        const products = this.db.getProducts();
        const prod = products.find(p => p.id === productId);
        const name = prod ? prod.name : 'Machine';

        const index = this.favorites.indexOf(productId);
        if (index > -1) {
            this.favorites.splice(index, 1);
            this.saveFavorites();
        } else {
            this.favorites.push(productId);
            this.saveFavorites();
        }

        // Update card buttons across any active grids
        document.querySelectorAll(`.btn-fav-card[data-id="${productId}"]`).forEach(btn => {
            const isFav = this.isFavorite(productId);
            btn.className = `btn-fav-card ${isFav ? 'active' : ''}`;
            btn.title = isFav ? 'Remove from Favorites' : 'Save to Favorites';
            btn.innerHTML = `<i class="${isFav ? 'fa-solid' : 'fa-regular'} fa-heart"></i>`;
        });

        // Update inspect modal favorite button if open
        if (this.currentInspectProductId === productId) {
            const favBtn = document.getElementById('inspect-fav-btn');
            if (favBtn) {
                const isFav = this.isFavorite(productId);
                favBtn.innerHTML = `<i class="${isFav ? 'fa-solid' : 'fa-regular'} fa-heart"></i>`;
                favBtn.style.color = isFav ? '#e53e3e' : 'var(--text-light)';
                favBtn.title = isFav ? 'Remove from Favorites' : 'Save to Favorites';
            }
        }

        // Re-render favorites view if currently open
        if (this.activeView === 'client-favorites') {
            this.renderFavorites();
        }
    }

    updateFavoritesBadges() {
        const count = Array.isArray(this.favorites) ? this.favorites.length : 0;
        document.querySelectorAll('.favorites-count').forEach(el => {
            el.innerText = count;
        });
    }

    updateCartBadges() {
        const totalQty = Array.isArray(this.cart) ? this.cart.reduce((sum, item) => sum + (Number(item.qty) || 0), 0) : 0;
        document.querySelectorAll('.cart-count').forEach(el => {
            el.innerText = totalQty;
        });
    }

    renderFavorites() {
        this.updateFavoritesBadges();
        const grid = document.getElementById('favorites-catalog-grid');
        const emptyMsg = document.getElementById('favorites-empty-msg');
        const addAllBtn = document.getElementById('btn-fav-add-all');
        if (!grid) return;

        grid.innerHTML = '';
        const allProducts = this.db.getProducts();
        const favProducts = allProducts.filter(p => this.favorites.includes(p.id));

        if (favProducts.length === 0) {
            if (emptyMsg) emptyMsg.style.display = 'block';
            if (addAllBtn) addAllBtn.style.display = 'none';
            return;
        }

        if (emptyMsg) emptyMsg.style.display = 'none';
        if (addAllBtn) addAllBtn.style.display = 'inline-flex';

        favProducts.forEach(p => {
            const discPrice = this.getDiscountedPrice(p);
            const hasPromo = !p.priceDisplay && discPrice < p.price;
            let priceHtml = '';
            if (p.priceDisplay) {
                priceHtml = `<div class="product-price" style="font-weight: 800; color: #1e3a8a; letter-spacing: -0.2px;"><strong style="font-weight: 800;">${p.priceDisplay}</strong></div>`;
            } else if (hasPromo) {
                priceHtml = `<div class="product-price"><span class="original-price">GH₵ ${p.price.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span><span class="promo-price">GH₵ ${discPrice.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span></div>`;
            } else {
                priceHtml = `<div class="product-price">GH₵ ${p.price.toLocaleString(undefined, { minimumFractionDigits: 2 })}</div>`;
            }

            const isLocalOrLaptop = p.category === 'Laptops' || (p.images && p.images[0] && p.images[0].startsWith('images/products/'));
            const fitStyle = isLocalOrLaptop ? 'object-fit:cover;' : 'object-fit:contain; background:#ffffff; padding:6px;';
            const noPhotoPlaceholder = `<div class="no-photo-placeholder" style="width:100%; height:100%; display:flex; flex-direction:column; align-items:center; justify-content:center; background:#f8fafc; color:#94a3b8; text-align:center; padding:16px; user-select:none;"><i class="fa-solid fa-camera" style="font-size:26px; margin-bottom:6px; opacity:0.6;"></i><span style="font-size:11px; font-weight:600; letter-spacing:0.3px; color:#64748b;">No Picture Available</span></div>`;
            const mainImg = (p.images && p.images.length > 0 && p.images[0])
                ? `<img src="${p.images[0]}" alt="${p.name}" loading="lazy" referrerpolicy="no-referrer" style="width:100%; height:100%; ${fitStyle} object-position:center; display:block;" onerror="this.style.display='none'; if(this.nextElementSibling) this.nextElementSibling.style.display='flex';"><div class="no-photo-placeholder" style="display:none; width:100%; height:100%; flex-direction:column; align-items:center; justify-content:center; background:#f8fafc; color:#94a3b8; text-align:center; padding:16px; user-select:none;"><i class="fa-solid fa-camera" style="font-size:26px; margin-bottom:6px; opacity:0.6;"></i><span style="font-size:11px; font-weight:600; letter-spacing:0.3px; color:#64748b;">No Picture Available</span></div>`
                : noPhotoPlaceholder;

            const specsArray = p.spec ? p.spec.split(/,|\n/).map(s => s.trim()).filter(s => s.length > 0) : [];
            const shortSpec = specsArray.length > 2
                ? `${specsArray[0]}, ${specsArray[1]}... <span style="color: var(--primary); font-weight: 700; text-decoration: underline;">See Details</span>`
                : (p.spec || 'No specifications listed.');

            const card = document.createElement('div');
            card.className = 'card product-card';
            card.style.position = 'relative';
            card.style.cursor = 'pointer';
            card.onclick = (e) => {
                if (!e.target.closest('button')) {
                    this.openInspectModal(p.id);
                }
            };

            card.innerHTML = `
                ${promoBadge}
                <button class="btn-fav-card active" data-id="${p.id}" onclick="event.stopPropagation(); app.toggleFavorite('${p.id}')" title="Remove from Favorites" aria-label="Favorite">
                    <i class="fa-solid fa-heart"></i>
                </button>
                <div style="display: flex; flex-direction: column; flex-grow: 1; justify-content: space-between; pointer-events: none;">
                    <div>
                        <div class="product-img">${mainImg}</div>
                        <h4 style="font-weight: 700; color: var(--text-dark); height: 44px; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; margin-top: 8px; font-size: 15px; line-height: 1.4;">${p.name}</h4>
                        <p style="font-size: 12px; color: var(--text-light); margin-top: 4px; line-height: 1.4;">${shortSpec}</p>
                    </div>
                    ${priceHtml}
                </div>
                <div style="margin-top: 16px; display: flex; flex-direction: column; gap: 8px; position: relative; z-index: 5;">
                    <div style="display: flex; justify-content: space-between; align-items: center;">
                        <span style="font-size: 12px; font-weight: 600; color: ${p.stock <= 0 ? 'var(--error)' : 'var(--success)'};">
                            ${p.stock <= 0 ? 'Out of Stock' : 'In Stock'}
                        </span>
                        <span style="font-size: 11px; color: var(--text-light);"><i class="fa-solid fa-clock-rotate-left"></i> Saved for later</span>
                    </div>
                    <div style="display: flex; gap: 8px;">
                        <button class="btn btn-outline" style="flex: 1; padding: 8px 10px; font-size: 13px;" onclick="event.stopPropagation(); app.addToCart('${p.id}')" ${p.stock <= 0 ? 'disabled' : ''}>
                            <i class="fa-solid fa-cart-plus"></i> Add to Cart
                        </button>
                        <button class="btn btn-primary" style="flex: 1; padding: 8px 10px; font-size: 13px;" onclick="event.stopPropagation(); app.buyFavoriteNow('${p.id}')" ${p.stock <= 0 ? 'disabled' : ''}>
                            <i class="fa-solid fa-bolt"></i> Buy Now
                        </button>
                    </div>
                </div>
            `;
            grid.appendChild(card);
        });
    }

    buyFavoriteNow(productId) {
        this.addToCart(productId);
        this.switchView('client-cart');
    }

    addAllFavoritesToCart() {
        const allProducts = this.db.getProducts();
        const favProducts = allProducts.filter(p => this.favorites.includes(p.id) && p.stock > 0);
        if (favProducts.length === 0) {
            this.showToast('No in-stock favorite machines to add.', 'error');
            return;
        }

        let addedCount = 0;
        favProducts.forEach(p => {
            const existing = this.cart.find(item => item.id === p.id);
            if (!existing) {
                const activePrice = this.getDiscountedPrice(p);
                this.cart.push({ id: p.id, name: p.name, price: activePrice, qty: 1, icon: p.icon });
                addedCount++;
            }
        });

        this.saveCart();
        this.showToast(`Added ${favProducts.length} favorite machine(s) to your cart!`);
        this.switchView('client-cart');
    }

    initSession() {
        const token = safeLocalStorage.getItem('kmap_auth_token');
        const savedUser = safeLocalStorage.getItem('kmap_current_user');
        if (token && savedUser) {
            try {
                this.currentUser = JSON.parse(savedUser);
                // Verify cryptographic session token with server
                fetch(getAuthApiUrl(), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                    body: JSON.stringify({ action: 'verify' })
                }).then(async res => {
                    if (res.ok) {
                        const data = await res.json().catch(() => ({}));
                        if (data.user) {
                            this.currentUser = data.user;
                            safeLocalStorage.setItem('kmap_current_user', JSON.stringify(data.user));
                            this.updateProfileHeader(data.user);
                            this.renderSidebar();
                        }
                    } else if (res.status === 401) {
                        console.warn('Session token expired or invalidated by server');
                        this.logout();
                    }
                }).catch(() => {});
            } catch (e) {
                this.currentUser = { username: 'guest', role: 'guest', name: 'Guest Viewer' };
            }
        } else {
            this.currentUser = { username: 'guest', role: 'guest', name: 'Guest Viewer' };
            safeLocalStorage.removeItem('kmap_current_user');
            safeLocalStorage.removeItem('kmap_auth_token');
        }

        this.closeLoginModal();
        this.updateProfileHeader(this.currentUser);
        this.renderSidebar();
        this.loadCart();
        this.loadFavorites();

        // Strictly ensure the homepage landing-page is the initial entry point
        const hashView = window.location.hash ? window.location.hash.replace('#', '') : null;
        const isAdminHash = hashView && hashView.startsWith('admin-') && this.currentUser && ['admin', 'superadmin'].includes(this.currentUser.role);
        const initialView = isAdminHash && document.getElementById(`view-${hashView}`) ? hashView : 'landing-page';
        this.switchView(initialView, false);
        if (window.history && window.history.replaceState) {
            window.history.replaceState({ view: initialView }, '', '#' + initialView);
        }
        this.renderHomepageFeaturedLaptops();
        this.updateFeaturedPrices();
    }

    openLoginModal(tab = 'signin') {
        const modal = document.getElementById('modal-login');
        if (modal) {
            modal.classList.add('active');
            this.updateScrollLock();
            this.showAuthTab(tab);
            this.initGoogleAuth();
        }
    }

    showAuthTab(tab) {
        const loginForm = document.getElementById('login-form');
        const signupForm = document.getElementById('signup-form');
        const tabSignIn = document.getElementById('tab-btn-signin');
        const tabSignUp = document.getElementById('tab-btn-signup');
        const title = document.getElementById('auth-modal-title');
        const subtitle = document.getElementById('auth-modal-subtitle');
        const err = document.getElementById('login-error-msg');
        const googleLabel = document.getElementById('google-auth-btn-label');
        if (err) err.style.display = 'none';

        if (tab === 'signup') {
            if (loginForm) loginForm.style.display = 'none';
            if (signupForm) signupForm.style.display = 'block';
            if (title) title.innerText = 'Create an Account';
            if (subtitle) subtitle.innerText = 'Join Kmap Computers for quick checkout and order tracking';
            if (googleLabel) googleLabel.innerText = 'Sign up with Google';
            if (tabSignUp) {
                tabSignUp.classList.add('active');
                tabSignUp.style.background = '';
                tabSignUp.style.color = '';
                tabSignUp.style.border = '';
            }
            if (tabSignIn) {
                tabSignIn.classList.remove('active');
                tabSignIn.style.background = '';
                tabSignIn.style.color = '';
                tabSignIn.style.border = '';
            }
        } else {
            if (loginForm) loginForm.style.display = 'block';
            if (signupForm) signupForm.style.display = 'none';
            if (title) title.innerText = 'Welcome to Kmap';
            if (subtitle) subtitle.innerText = 'Sign in to manage your orders and profile';
            if (googleLabel) googleLabel.innerText = 'Continue with Google';
            if (tabSignIn) {
                tabSignIn.classList.add('active');
                tabSignIn.style.background = '';
                tabSignIn.style.color = '';
                tabSignIn.style.border = '';
            }
            if (tabSignUp) {
                tabSignUp.classList.remove('active');
                tabSignUp.style.background = '';
                tabSignUp.style.color = '';
                tabSignUp.style.border = '';
            }
        }
    }

    closeLoginModal() {
        const modal = document.getElementById('modal-login');
        if (modal) modal.classList.remove('active');
        this.closeGoogleSetupModal();
        this.updateScrollLock();
    }

    initGoogleAuth() {
        const clientId = window.KMAP_GOOGLE_CLIENT_ID || safeLocalStorage.getItem('kmap_google_client_id') || '222160997701-3gb6hejra6jim1hu76roejl7rcgllgom.apps.googleusercontent.com';
        window.KMAP_GOOGLE_CLIENT_ID = clientId;

        if (window.google && window.google.accounts && window.google.accounts.id) {
            try {
                window.google.accounts.id.initialize({
                    client_id: clientId,
                    callback: (res) => this.handleGoogleCredentialResponse(res),
                    auto_select: false,
                    cancel_on_tap_outside: true
                });

                const renderSlot = document.getElementById('g_id_signin_slot');
                if (renderSlot) {
                    renderSlot.style.display = 'flex';
                    renderSlot.innerHTML = '';
                    window.google.accounts.id.renderButton(renderSlot, {
                        theme: 'outline',
                        size: 'large',
                        width: 370,
                        text: 'continue_with',
                        shape: 'pill',
                        logo_alignment: 'left'
                    });
                    const fallbackBtn = document.getElementById('btn-google-auth');
                    if (fallbackBtn) fallbackBtn.style.display = 'none';
                }
            } catch (e) {
                console.warn('Google GSI initialization notice:', e);
            }
        } else {
            if (!this._gsiRetryCount) this._gsiRetryCount = 0;
            if (this._gsiRetryCount < 8) {
                this._gsiRetryCount++;
                setTimeout(() => this.initGoogleAuth(), 350);
            }
        }
    }

    async signInWithGoogle() {
        const clientId = window.KMAP_GOOGLE_CLIENT_ID || safeLocalStorage.getItem('kmap_google_client_id') || '222160997701-3gb6hejra6jim1hu76roejl7rcgllgom.apps.googleusercontent.com';
        if (window.google && window.google.accounts && window.google.accounts.id) {
            try {
                window.google.accounts.id.initialize({
                    client_id: clientId,
                    callback: (res) => this.handleGoogleCredentialResponse(res),
                    auto_select: false,
                    cancel_on_tap_outside: true
                });
                window.google.accounts.id.prompt((notification) => {
                    if (notification.isNotDisplayed() || notification.isSkippedMoment()) {
                        console.log('Google prompt not displayed/skipped');
                    }
                });
                return;
            } catch (e) {
                console.warn('Google prompt exception:', e);
            }
        }
        this.initGoogleAuth();
    }

    openGoogleSetupOrDemoModal() {
        const modal = document.getElementById('modal-google-setup');
        if (modal) {
            modal.classList.add('active');
            this.updateScrollLock();
            const existingId = safeLocalStorage.getItem('kmap_google_client_id');
            const idInput = document.getElementById('custom-google-client-id');
            if (idInput && existingId) idInput.value = existingId;
        }
    }

    closeGoogleSetupModal() {
        const modal = document.getElementById('modal-google-setup');
        if (modal) modal.classList.remove('active');
        this.updateScrollLock();
    }

    saveGoogleClientId() {
        const input = document.getElementById('custom-google-client-id');
        const val = input ? input.value.trim() : '';
        if (!val) {
            this.showToast("Please enter a valid Google Client ID.", 'error');
            return;
        }
        safeLocalStorage.setItem('kmap_google_client_id', val);
        window.KMAP_GOOGLE_CLIENT_ID = val;
        this.initGoogleAuth();
        this.showToast("Google Client ID saved! Google One-Tap & buttons initialized.", 'success');
        this.closeGoogleSetupModal();
    }

    async submitQuickGoogleLogin() {
        const nameInput = document.getElementById('google-account-name');
        const emailInput = document.getElementById('google-account-email');
        const name = nameInput ? nameInput.value.trim() : '';
        const email = emailInput ? emailInput.value.trim() : '';

        if (!name || !email) {
            this.showToast("Please enter both your name and Google email address.", 'error');
            return;
        }

        const btn = document.getElementById('btn-confirm-google-connect');
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Connecting Account...';
        }

        await this.handleGoogleProfileLogin(name, email);

        if (btn) {
            btn.disabled = false;
            btn.innerHTML = '<i class="fa-brands fa-google"></i> Continue as Google User';
        }
    }

    async handleGoogleCredentialResponse(response) {
        if (!response || !response.credential) return;

        const err = document.getElementById('login-error-msg');
        if (err) err.style.display = 'none';

        const btn = document.getElementById('btn-google-auth');
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Verifying with Google...';
        }

        try {
            const res = await fetch(getAuthApiUrl(), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'google_login', credential: response.credential })
            });
            const data = await res.json().catch(() => ({}));

            if (res.ok && data.success && data.user && data.token) {
                safeLocalStorage.setItem('kmap_auth_token', data.token);
                safeLocalStorage.setItem('kmap_current_user', JSON.stringify(data.user));
                this.currentUser = data.user;
                this.loadCart();
                this.closeLoginModal();
                this.updateProfileHeader(data.user);
                this.renderSidebar();
                this.syncDownstream();

                this.showToast(`Welcome, ${data.user.name || data.user.username}! Signed in with Google.`, 'success');
                this.switchView('landing-page');
            } else {
                if (err) {
                    err.innerText = data.error || "Google authentication failed. Please try again.";
                    err.style.display = 'block';
                }
            }
        } catch (netErr) {
            if (err) {
                err.innerText = "Connection error during Google authentication.";
                err.style.display = 'block';
            }
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = `
                    <svg width="20" height="20" viewBox="0 0 48 48" style="display: block;">
                        <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
                        <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
                        <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
                        <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
                    </svg>
                    <span id="google-auth-btn-label">Continue with Google</span>
                `;
            }
        }
    }

    async handleGoogleProfileLogin(name, email) {
        try {
            const res = await fetch(getAuthApiUrl(), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    action: 'google_login',
                    profile: { name, email, sub: 'G-' + Date.now() }
                })
            });
            const data = await res.json().catch(() => ({}));
            if (res.ok && data.success && data.user && data.token) {
                safeLocalStorage.setItem('kmap_auth_token', data.token);
                safeLocalStorage.setItem('kmap_current_user', JSON.stringify(data.user));
                this.currentUser = data.user;
                this.loadCart();
                this.closeLoginModal();
                this.closeGoogleSetupModal();
                this.updateProfileHeader(data.user);
                this.renderSidebar();
                this.syncDownstream();
                this.showToast(`Welcome, ${data.user.name}! Registered with Google account.`, 'success');
                this.switchView('landing-page');
            } else {
                this.showToast(data.error || "Failed to complete Google sign-in.", 'error');
            }
        } catch (e) {
            this.showToast("Google sign-in error: " + e.message, 'error');
        }
    }

    updateScrollLock() {
        const hasActiveModal = !!document.querySelector('.modal-overlay.active, .lightbox-overlay.active');
        if (hasActiveModal) {
            document.body.classList.add('modal-open');
        } else {
            document.body.classList.remove('modal-open');
        }
    }

    updateProfileHeader(user) {
        const profileName = document.getElementById('profile-name');
        const profileAvatar = document.getElementById('profile-avatar');
        const profileRole = document.getElementById('profile-role');
        const btnSignIn = document.getElementById('btn-topbar-signin');
        const userProfile = document.getElementById('topbar-user-profile');
        const changePwdBtn = document.getElementById('sidebar-change-pwd-btn');
        const adminToggleBtn = document.getElementById('btn-topbar-admin-toggle');
        const landingAccountLabel = document.getElementById('landing-account-label');
        const landingAccountBtn = document.getElementById('landing-account-btn');
        const landingAccountIcon = document.getElementById('landing-account-icon');

        const syncIndicator = document.getElementById('sync-status-indicator');
        const isAdmin = user && ['admin', 'superadmin'].includes(user.role);
        if (syncIndicator) {
            syncIndicator.style.display = isAdmin ? 'inline-flex' : 'none';
        }

        if (user && user.role !== 'guest') {
            if (profileName) profileName.innerText = user.name || user.username;
            if (profileAvatar) {
                if (user.picture) {
                    profileAvatar.innerHTML = `<img src="${user.picture}" alt="${user.name || user.username}" style="width: 100%; height: 100%; border-radius: 50%; object-fit: cover;">`;
                } else {
                    profileAvatar.innerText = (user.name || user.username).charAt(0).toUpperCase();
                }
            }
            if (profileRole) profileRole.innerText = user.role === 'superadmin' ? 'Super Admin' : (user.role === 'admin' ? 'Staff' : 'Customer');
            if (btnSignIn) btnSignIn.style.display = 'none';
            if (userProfile) userProfile.style.display = 'flex';
            if (changePwdBtn) changePwdBtn.style.display = 'flex';
            if (adminToggleBtn) {
                adminToggleBtn.style.display = isAdmin ? 'inline-flex' : 'none';
            }
            if (landingAccountLabel) {
                const firstName = (user.name || user.username || '').trim().split(' ')[0];
                landingAccountLabel.innerText = firstName || 'Account';
            }
            if (landingAccountBtn) {
                landingAccountBtn.title = `Signed in as ${user.name || user.username} - View Profile`;
            }
            if (landingAccountIcon) {
                landingAccountIcon.className = 'fa-solid fa-user-check';
            }
        } else {
            if (profileName) profileName.innerText = 'Guest';
            if (profileAvatar) profileAvatar.innerText = 'G';
            if (profileRole) profileRole.innerText = '';
            if (btnSignIn) btnSignIn.style.display = 'inline-flex';
            if (userProfile) userProfile.style.display = 'none';
            if (changePwdBtn) changePwdBtn.style.display = 'none';
            if (adminToggleBtn) adminToggleBtn.style.display = 'none';
            if (landingAccountLabel) landingAccountLabel.innerText = 'Account';
            if (landingAccountBtn) landingAccountBtn.title = 'Sign In / Create Account';
            if (landingAccountIcon) landingAccountIcon.className = 'fa-regular fa-user';
        }
    }

    toggleAdminMarketplaceView() {
        if (this.activeView && this.activeView.startsWith('admin-')) {
            this.switchView('client-store');
        } else {
            this.switchView('admin-dashboard');
        }
    }

    // Initialize mock database in localStorage
    initDatabase() {
                        const defaultProducts = [
            {
                id: 'PROD-001',
                name: "Hp Zbook 15u G6",
                category: 'Laptops',
                price: 8750,
                stock: 10,
                spec: "Intel Core i7, 8th Generation, 32GB Memory, 1TB Solid state Drive, 8CPUs @ 1.8Ghz Speed, AMD Radeon RX Graphics *4GB Dedicated Graphics*, Fingerprint Security, 2Type C USB Slots, Hdmi & USB Slots, 15.6 inch Screen Size, Strong Battery",
                icon: '💻',
                images: [
                    'images/products/PROD-001/1.jpg',
                    'images/products/PROD-001/2.jpg',
                    'images/products/PROD-001/3.jpg',
                    'images/products/PROD-001/4.jpg'
                ]
            },
            {
                id: 'PROD-002',
                name: "HP Probook x360 435 G7",
                category: 'Laptops',
                price: 6000,
                stock: 10,
                spec: "AMD Ryzen 7 PRO, 16GB Memory, 256GB Solid state Drive, 8CPUs @ 1.9Ghz Speed, AMD Radeon RX Graphics *Dedicated Graphics*, Fingerprint Security, HD camera, Touchscreen, 2Type C USB Slots, Hdmi & USB Slots, 14.0 inch Screen Size, Strong Battery, Hdmi & USB Slots, 15.6 inch Screen Size, Strong Battery",
                icon: '💻',
                images: [
                    'images/products/PROD-002/1.jpg',
                    'images/products/PROD-002/2.jpg',
                    'images/products/PROD-002/3.jpg',
                    'images/products/PROD-002/4.jpg',
                    'images/products/PROD-002/5.jpg',
                    'images/products/PROD-002/6.jpg'
                ]
            },
            {
                id: 'PROD-003',
                name: "Hp Probook 640 G5",
                category: 'Laptops',
                price: 4000,
                stock: 10,
                spec: "Intel Core i5, 8th Generation, 8gb Memory, 256gb Solid state Drive, 4CPUs @ 1.6Ghz Speed, Fingerprint Security, Backlit Keyboard, 1Type C USB Slots, Hdmi & USB Slots, 14.0 inch Screen Size, Strong Battery",
                icon: '💻',
                images: [
                    'images/products/PROD-003/1.jpg',
                    'images/products/PROD-003/2.jpg'
                ]
            },
            {
                id: 'PROD-004',
                name: "Hp Probook 430 G7",
                category: 'Laptops',
                price: 6000,
                stock: 10,
                spec: "Intel Core i5, 10th Generation, 16gb Memory, 256gb Solid state Drive, 4CPUs @ 1.6Ghz Speed, Fingerprint Security, Backlit Keyboard, 1Type C USB Slots, Hdmi & USB Slots, 14.0 inch Screen Size, Strong Battery",
                icon: '💻',
                images: [
                    'images/products/PROD-004/1.jpg',
                    'images/products/PROD-004/2.jpg',
                    'images/products/PROD-004/3.jpg'
                ]
            },
            {
                id: 'PROD-005',
                name: "Dell Latitude 5270",
                category: 'Laptops',
                price: 3250,
                stock: 10,
                spec: "Intel Core i5, 6th Generation, 8gb Memory, 256GB Solid state Drive, 8CPUs @ 2.40 Ghz Speed, Hdmi & USB Slots, 14.0 inch Screen Size, Strong Battery",
                icon: '💻',
                images: [
                    'images/products/PROD-005/1.jpg',
                    'images/products/PROD-005/2.jpg',
                    'images/products/PROD-005/3.jpg'
                ]
            },
            {
                id: 'PROD-006',
                name: "Dell Latitude 5400",
                category: 'Laptops',
                price: 5750,
                stock: 10,
                spec: "Intel Core i5, 8th Generation, 16gb Memory, 512gb Solid state Drive, 8CPUs @ 1.60 Ghz Speed, Backlit Keyboard, 2Type C USB Slots, Hdmi & USB Slots, 14.0 inch Screen Size, Strong Battery",
                icon: '💻',
                images: [
                    'images/products/PROD-006/1.jpg',
                    'images/products/PROD-006/2.jpg'
                ]
            },
            {
                id: 'PROD-007',
                name: "Dell Latitude 7320",
                category: 'Laptops',
                price: 7500,
                stock: 10,
                spec: "Intel Core i7, 11th Generation, 16gb Memory, 512gb Solid state Drive, 8CPUs @ 3.0Ghz Speed, Fingerprint Security, Backlit Keyboard, 2Type C USB Slots, Hdmi & USB Slots, 13.3inch Screen Size, Strong Battery",
                icon: '💻',
                images: [
                    'images/products/PROD-007/1.jpg',
                    'images/products/PROD-007/2.jpg'
                ]
            },
            {
                id: 'PROD-008',
                name: "Hp EliteBook 1040 G7",
                category: 'Laptops',
                price: 7500,
                stock: 10,
                spec: "Core i5 10th Generation, 16gbMemory, 256gb Solid state Drive, 8CPUs @ 1.7Ghz Speed, x360 Convertible, Touchscreen Display, Face iD Recognition, Fingerprint Security, Backlit Keyboard, 2Type C Slots, Hdmi & USB Slots, 14.0 inch Screen Size, Strong Battery",
                icon: '💻',
                images: [
                    'images/products/PROD-008/1.jpg',
                    'images/products/PROD-008/2.jpg'
                ]
            },
            {
                id: 'PROD-009',
                name: "Hp EliteBook 1030 G2",
                category: 'Laptops',
                price: 5000,
                stock: 10,
                spec: "Intel Core i5, 7th Generation, 8gb Memory, 256gb Solid state Drive, 4CPUs @ 2.6Ghz Speed, x360 Convertible, Touchscreen Display, Face iD Recognition, Fingerprint Security, Backlit Keyboard, 1Type C USB Slots, Hdmi & USB Slots, 14.0 inch Screen Size, Strong Battery",
                icon: '💻',
                images: [
                    'images/products/PROD-009/1.jpg',
                    'images/products/PROD-009/2.jpg',
                    'images/products/PROD-009/3.jpg'
                ]
            },
            {
                id: 'PROD-010',
                name: "Hp EliteBook 840 G5",
                category: 'Laptops',
                price: 3750,
                stock: 10,
                spec: "Intel Core i5, 7th Generation, 8gb Memory, 256gb Solid state Drive, 4CPUs @ 2.6Ghz Speed, Fingerprint Security, Backlit Keyboard, 1Type C USB Slots, Hdmi & USB Slots, 14.0 inch Screen Size, Strong Battery",
                icon: '💻',
                images: [
                    'images/products/PROD-010/1.jpg',
                    'images/products/PROD-010/2.jpg'
                ]
            },
            {
                id: 'PROD-011',
                name: "Hp EliteBook 830 G6",
                category: 'Laptops',
                price: 6000,
                stock: 10,
                spec: "Intel Core i5, 8th Generation, 16gb Memory, 256gb Solid state Drive, 4CPUs @ 1.6Ghz Speed, x360 Convertible, Fingerprint Security, Backlit Keyboard, 1Type C USB Slots, Hdmi & USB Slots, 14.0 inch Screen Size, Strong Battery",
                icon: '💻',
                images: [
                    'images/products/PROD-011/1.jpg',
                    'images/products/PROD-011/2.jpg'
                ]
            },
            {
                id: 'PROD-012',
                name: "Hp EliteBook 840 G3",
                category: 'Laptops',
                price: 3125,
                stock: 10,
                spec: "Intel Core i5, 6th Generation, 8gb Memory, 256gb Solid state Drive, 4CPUs @ 2.4Ghz Speed, Fingerprint Security, Backlit Keyboard, 1Type C USB Slot, Display port & USB Slots, 14.0 inch Screen Size, Strong Battery",
                icon: '💻',
                images: [
                    'images/products/PROD-012/1.jpg',
                    'images/products/PROD-012/2.jpg'
                ]
            },
            {
                id: 'PROD-013',
                name: "Dell Latitude 5320",
                category: 'Laptops',
                price: 8125,
                stock: 10,
                spec: "Intel Core i7, 11th Generation, 16gb Memory, 512gb Solid state Drive, 8CPUs @ 3.0Ghz Speed, 360 Convertible, Fingerprint Security, Backlit Keyboard, 2Type C USB Slots, Hdmi & USB Slots, 13.3inch Screen Size, Strong Battery",
                icon: '💻',
                images: [
                    'images/products/PROD-013/1.jpg',
                    'images/products/PROD-013/2.jpg',
                    'images/products/PROD-013/3.jpg'
                ]
            },
            {
                id: 'PROD-014',
                name: "Hp Elitebook x360 1040 G5",
                category: 'Laptops',
                price: 6000,
                stock: 10,
                spec: "Intel Core i5, 8th Generation, 8GB Memory, 256gb Solid state Drive, 8CPUs @ 1.7Ghz Speed, Fingerprint Security, 2Type C USB Slots, Hdmi & USB Slots, 14.0 inch Screen Size, Strong Battery",
                icon: '💻',
                images: [
                    'images/products/PROD-014/1.jpg'
                ]
            },
            {
                id: 'PROD-015',
                name: "Hp Spectre Pro x360 G2",
                category: 'Laptops',
                price: 4375,
                stock: 10,
                spec: "Intel Core i5, 6th Generation, 8gb Memory, 256gb Solid state Drive, 4CPUs @ 2.4Ghz Speed, x360 Convertible, Touchscreen Display, Backlit Keyboard, Hdmi & USB Slots, 14.0 inch Screen Size, Strong Battery",
                icon: '💻',
                images: [
                    'images/products/PROD-015/1.jpg',
                    'images/products/PROD-015/2.jpg'
                ]
            },
            {
                id: 'PROD-016',
                name: "Dell XPS 13 9360",
                category: 'Laptops',
                price: 4750,
                stock: 10,
                spec: "Intel Core i5, 7th Generation, 8Gb Memory, 256gb Solid state Drive, 8CPUs @ 2.6Ghz Speed, Fingerprint Security, Backlit Keyboard, Type C USB Slot, USB Slots, 13.3inch Screen Size, Strong Battery",
                icon: '💻',
                images: [
                    'images/products/PROD-016/1.jpg',
                    'images/products/PROD-016/2.jpg',
                    'images/products/PROD-016/3.jpg',
                    'images/products/PROD-016/4.jpg',
                    'images/products/PROD-016/5.jpg',
                    'images/products/PROD-016/6.jpg'
                ]
            },
            {
                id: 'PROD-017',
                name: "Dell latitude 7290",
                category: 'Laptops',
                price: 3750,
                stock: 10,
                spec: "Intel Core i5, 7th Generation, 8Gb Memory, 256gb Solid state Drive, 8CPUs @ 2.6Ghz Speed, Backlit Keyboard, Type C USB Slot, USB Slots, 13.3inch Screen Size, Strong Battery",
                icon: '💻',
                images: [
                    'images/products/PROD-017/1.jpg',
                    'images/products/PROD-017/2.jpg'
                ]
            },
            {
                id: 'PROD-018',
                name: "Hp Elitebook 840 G8",
                category: 'Laptops',
                price: 7875,
                stock: 10,
                spec: "Intel Core i7, 11th Generation, 32GB Memory, 512GB Solid state Drive, 8CPUs @ 3.0 Ghz Speed, Fingerprint Security, 2Type C USB Slots, Hdmi & USB Slots, 14.0 inch Screen Size, Strong Battery",
                icon: '💻',
                images: [
                    'images/products/PROD-018/1.jpg',
                    'images/products/PROD-018/2.jpg',
                    'images/products/PROD-018/3.jpg'
                ]
            },
            {
                id: 'PROD-019',
                name: "Hp Elitebook x360 1030 G3 (Core i5)",
                category: 'Laptops',
                price: 5000,
                stock: 10,
                spec: "Intel Core i5, 8th Generation, 8GB Memory, 256gb Solid state Drive, 8CPUs @ 1.7Ghz Speed, Fingerprint Security, 2Type C USB Slots, Hdmi & USB Slots, 13.0 inch Screen Size, Strong Battery",
                icon: '💻',
                images: [
                    'images/products/PROD-019/1.jpg'
                ]
            },
            {
                id: 'PROD-020',
                name: "Hp Elitebook x360 1030 G3 (Core i7)",
                category: 'Laptops',
                price: 6000,
                stock: 10,
                spec: "Intel Core i7, 8th Generation, 16GB Memory, 256gb Solid state Drive, 8CPUs @ 1.7Ghz Speed, Fingerprint Security, 2Type C USB Slots, Hdmi & USB Slots, 13.0 inch Screen Size, Strong Battery",
                icon: '💻',
                images: [
                    'images/products/PROD-020/1.jpg'
                ]
            },
            {
                id: 'PROD-021',
                name: "Dell Latitude 5410",
                category: 'Laptops',
                price: 4250,
                stock: 10,
                spec: "Intel Core i5, 10th Generation, 16gb Memory, 512gb Solid state Drive, 8CPUs @ 1.60 Ghz Speed, Backlit Keyboard, 2Type C USB Slots, Hdmi & USB Slots, 14.0 inch Screen Size, Strong Battery",
                icon: '💻',
                images: [
                    'images/products/PROD-021/1.jpg',
                    'images/products/PROD-021/2.jpg'
                ]
            },
            {
                id: 'PROD-022',
                name: "Dell Latitude 7420",
                category: 'Laptops',
                price: 5625,
                stock: 10,
                spec: "Intel Core i5, 11th Generation, 16gb Memory, 512gb Solid state Drive, 8CPUs @ 2.6Ghz Speed, Fingerprint Security, Backlit Keyboard, 2Type C USB Slots, Hdmi & USB Slots, 13.3inch Screen Size, Strong Battery",
                icon: '💻',
                images: [
                    'images/products/PROD-022/1.jpg',
                    'images/products/PROD-022/2.jpg',
                    'images/products/PROD-022/3.jpg'
                ]
            },
            {
                id: 'PROD-023',
                name: "Lenovo Thinkpad T480s",
                category: 'Laptops',
                price: 3600,
                stock: 10,
                spec: "Intel Core i5, 8th Generation, 16gb Memory, 256gb Solid state Drive, 4CPUs @ 1.60GHz, Type C USB Slot, Hdmi & USB Slots, 14.0 inch Screen Size, Strong Battery",
                icon: '💻',
                images: [
                    'images/products/PROD-023/1.jpg'
                ]
            },
            {
                id: 'PROD-024',
                name: "Lenovo Thinkpad T470s",
                category: 'Laptops',
                price: 5125,
                stock: 10,
                spec: "Touchscreen, Intel Core i5, 6th Generation, 12gb Memory, 512gb Solid state Drive, 4CPUs @ 2.3GHz, Type C USB Slot, Hdmi & USB Slots, 14.0 inch Screen Size, Strong Battery",
                icon: '💻',
                images: [
                    'images/products/PROD-024/1.jpg',
                    'images/products/PROD-024/2.jpg'
                ]
            },
            {
                id: 'PROD-025',
                name: "Hp OMEN 15 (Core i7 / GTX 1050Ti)",
                category: 'Laptops',
                price: 8500,
                stock: 10,
                spec: "Intel Core i7 7th Generation, 2.8 GHz up to 3.2GHz, 16GB Ddr4 Ram, 256GB SSD + 1TB HDD, GTX 1050ti 4GB GPU, Keyboard Light, 15.6 inch 60Hz IPS LED Display (1920 x 1080), Cam + Mic, Black Color, Windows 11, B&O Audio, Lithium-Ion Battery, 150W Charger",
                icon: '💻',
                images: [
                    'images/products/PROD-025/1.jpg',
                    'images/products/PROD-025/2.jpg',
                    'images/products/PROD-025/3.jpg',
                    'images/products/PROD-025/4.jpg'
                ]
            },
            {
                id: 'PROD-026',
                name: "Hp OMEN 15 (Core i5 / GTX 1050)",
                category: 'Laptops',
                price: 7375,
                stock: 10,
                spec: "Intel Core i5 8th Generation, 2.3GHz upto 3.2GHz, 12GB Ddr4 Ram, 256GB SSD + 1TB HDD, GTX 1050 GPU 2GB Dedicated, Keyboard Light, 15.6 inch WQXGA 60Hz IPS LED Display (1920 x 1080), Cam + Mic, Black Color, Windows 11, B&O Audio, Lithium-Ion Battery, 150W Charger",
                icon: '💻',
                images: [
                    'images/products/PROD-026/1.jpg',
                    'images/products/PROD-026/2.jpg'
                ]
            },
            {
                id: 'PROD-027',
                name: "Hp OMEN 15 (Ryzen 7 / RTX 2060)",
                category: 'Laptops',
                price: 11875,
                stock: 10,
                spec: "AMD Ryzen 7-5800H 2.9GHz upto 4.2GHz, 16GB Ddr4 Ram, 512GB SSD + 128GB SSD, RTX 2060 GPU 6GB Dedicated, RGB Keyboard Light, 15.6 inch WQXGA 144Hz IPS LED Display (1920 x 1080), Cam + Mic, Black Color, Windows 11, B&O Audio, Lithium-Ion Battery, 200W Charger",
                icon: '💻',
                images: [
                    'images/products/PROD-027/1.jpg',
                    'images/products/PROD-027/2.jpg',
                    'images/products/PROD-027/3.jpg',
                    'images/products/PROD-027/4.jpg',
                    'images/products/PROD-027/5.jpg',
                    'images/products/PROD-027/6.jpg'
                ]
            },
            {
                id: 'PROD-028',
                name: "Hp Probook 650 G8",
                category: 'Laptops',
                price: 6000,
                stock: 10,
                spec: "Intel Core i5, 11th Generation, 16gb Memory, 256gb Solid state Drive, 8CPUs @ 2.4Ghz Speed, Fingerprint Security, Backlit Keyboard, 1Type C USB Slots, Hdmi & USB Slots, 14.0 inch Screen Size, Strong Battery",
                icon: '💻',
                images: [
                    'images/products/PROD-028/1.jpg'
                ]
            },
            {
                id: 'PROD-029',
                name: "Toshiba Portege X20W",
                category: 'Laptops',
                price: 4750,
                stock: 10,
                spec: "Intel Core i7, 7th Generation, 16Gb Memory, 256gb Solid state Drive, 8CPUs @ 2.7Ghz Speed, X360 Touchscreen, Face ID Security, Backlit Keyboard, Type C USB Slot, USB Slots, 13.3inch Screen Size, Strong Battery",
                icon: '💻',
                images: [
                    'images/products/PROD-029/1.jpg',
                    'images/products/PROD-029/2.jpg'
                ]
            },
            {
                id: 'PROD-030',
                name: "Lenovo Yoga 11e",
                category: 'Laptops',
                price: 2438,
                stock: 10,
                spec: "Intel Core i3, 6th Generation, 8gb Memory, 256gb Solid state Drive, 4CPUs @ 2.3GHz, x360 Convertible, Touchscreen Display, Type C USB Slots, Hdmi & USB Slots, 12.5 inch Screen Size, Strong Battery",
                icon: '💻',
                images: [
                    'images/products/PROD-030/1.jpg'
                ]
            },
            {
                id: 'PROD-031',
                name: "Hp Elitebook x360 830 G8",
                category: 'Laptops',
                price: 8125,
                stock: 10,
                spec: "Intel Core i5, 11th Generation, 16GB Memory, 512gb Solid state Drive, 8CPUs @ 1.6 Ghz Speed, Fingerprint Security, 2Type C USB Slots, Hdmi & USB Slots, 14.0 inch Screen Size, Strong Battery",
                icon: '💻',
                images: [
                    'images/products/PROD-031/1.jpg',
                    'images/products/PROD-031/2.jpg'
                ]
            },
            {
                id: 'PROD-ACC-001',
                name: "2.5\" HDD/SSD External Enclosure Case",
                category: 'Accessories',
                price: 100,
                stock: 25,
                spec: "High Speed USB 3.0 to SATA 2.5 inch HDD/SSD Enclosure case, plug and play, driver-free, intelligent sleep mode",
                icon: '🔌',
                images: [
                    'images/landing/hdd-ssd-case.jpg'
                ]
            },
            {
                id: 'PROD-ACC-002',
                name: "Type-C to HDTV 8-in-1 Multifunction Adapter",
                category: 'Accessories',
                price: 250,
                stock: 15,
                spec: "4K UHD HDMI, Type-C Power Delivery, 2x USB 3.0, Type-C Data, SD/TF Card Reader, Gigabit RJ45 Ethernet Port",
                icon: '🔌',
                images: [
                    'images/landing/typec-hdtv-8in1.jpg'
                ]
            },
            {
                id: 'PROD-ACC-003',
                name: "Foldable Aluminum Laptop Stand",
                category: 'Accessories',
                price: 100,
                stock: 20,
                spec: "Ergonomic Multi-Angle Height Adjustment, Sturdy Premium Aluminum Alloy, Anti-Slip Silicone Pads, Heat Dissipation",
                icon: '📐',
                images: [
                    'images/landing/laptop-stand.jpg'
                ]
            },
            {
                id: 'PROD-ACC-004',
                name: "Type-C 7-in-1 Dual USB Hub Adapter",
                category: 'Accessories',
                price: 150,
                stock: 18,
                spec: "Dual Type-C & USB-A Host Connector, High Speed USB 3.0 & 2.0 Ports, Power LED Indicator, BC1.2 Fast Charging Support",
                icon: '🔌',
                images: [
                    'images/landing/typec-adapter-7in1.jpg'
                ]
            },
            {
                id: 'PROD-USB-002',
                name: "Kingston DataTraveler 32GB USB 3.2 Flash Drive",
                category: 'Accessories',
                price: 120,
                stock: 50,
                spec: "Brand: Kingston, Model: DataTraveler Exodia, Capacity: 32GB, Interface: USB 3.2 Gen 1 (Backwards compatible with USB 2.0), Read Speed: up to 65MB/s, Protective Cap with Large Keyring Loop, Compact & Durable, Compatible with Windows, Mac OS & Linux",
                icon: '💾',
                images: [
                    'https://c1.neweggimages.com/productimage/nb640/A12KS20102019HDK.jpg'
                ]
            },
            {
                id: 'PROD-USB-003',
                name: "Kingston DataTraveler 64GB USB 3.2 Flash Drive",
                category: 'Accessories',
                price: 150,
                stock: 50,
                spec: "Brand: Kingston, Model: DataTraveler Exodia, Capacity: 64GB, Interface: USB 3.2 Gen 1 High Speed, Read Speed: up to 70MB/s, Quick File Transfers for Documents, Music, Videos & Photos, Protective Cap Design with Loop, High Durability",
                icon: '💾',
                images: [
                    'https://c1.neweggimages.com/productimage/nb640/A12KS20102019HDK.jpg'
                ]
            },
            {
                id: 'PROD-ACC-M01',
                name: "T-Wolf V1 RGB LED Wired Optical Gaming Mouse",
                category: 'Accessories',
                price: 50,
                stock: 40,
                spec: "Brand: T-Wolf, Model: V1, Lighting: 7-Color Breathing RGB LED Backlight, Sensor: High-Precision Optical Sensor, Resolution: 1200 DPI, Ergonomic 3D Contour Comfort Grip, Anti-Skid Illuminated Scroll Wheel, 1.35m Durable Cable, Plug & Play (No Drivers Required), Compatible with Windows & Mac OS",
                icon: '🖱️',
                images: [
                    'https://m.media-amazon.com/images/I/61UO3-aDj3L._AC_SL1500_.jpg'
                ]
            },
            {
                id: 'PROD-ACC-M02',
                name: "Compoint CP-M161W 2.4GHz Wireless Optical Mouse",
                category: 'Accessories',
                price: 80,
                stock: 35,
                spec: "Brand: Compoint, Model: CP-M161W, Connectivity: 2.4GHz Wireless via Nano USB Receiver (Non-Bluetooth), Operating Range: 10 Meters, Resolution: 1600 DPI High-Definition Optical Tracking, Ultra-Slim Symmetrical Ergonomic Design, Smart Auto-Sleep Energy Saving",
                icon: '🖱️',
                images: [
                    'https://www.pcbelfast.co.uk/wp-content/uploads/2020/03/MICOM-CPM161WW.jpg'
                ]
            },
            {
                id: 'PROD-ACC-M03',
                name: "Dual-Mode Bluetooth 5.2 & 2.4GHz Wireless Mouse",
                category: 'Accessories',
                price: 100,
                stock: 30,
                spec: "Connectivity: Dual-Mode (Bluetooth 5.2 + 2.4GHz USB Dongle), Multi-Device Quick Switching, Built-in Rechargeable Battery (Type-C / Micro-USB Charging), Whisper-Quiet Silent Clicks, 3-Level Adjustable DPI (800 / 1200 / 1600 DPI), Slim Portable Profile",
                icon: '🖱️',
                images: [
                    'https://images.unsplash.com/photo-1605773527852-c546a8584ea3?w=600&auto=format&fit=crop&q=80'
                ]
            },
            {
                id: 'PROD-NET-001',
                name: "Mini USB Wireless WiFi Network Adapter Dongle",
                category: 'Networking',
                price: 60,
                stock: 45,
                spec: "Interface: USB 2.0 High Speed, Wireless Standard: IEEE 802.11 b/g/n (2.4GHz), Speed: Up to 150Mbps / 300Mbps, Ultra-Compact Nano Design (Leave plugged in without blocking adjacent ports), Supports Windows 11/10/8/7, WPA2 Wireless Security Encryption",
                icon: '📶',
                images: [
                    'https://m.media-amazon.com/images/I/61Y-tL7-dBL._AC_SL1500_.jpg'
                ]
            },
            {
                id: 'PROD-NET-002',
                name: "2-in-1 Dual Band USB WiFi + Bluetooth 5.0 Wireless Dongle",
                category: 'Networking',
                price: 100,
                stock: 30,
                spec: "Dual Function: High-Speed WiFi (600Mbps Dual Band 2.4GHz & 5GHz) + Bluetooth 5.0 Receiver & Transmitter, Connect to High-Speed WiFi and Pair Bluetooth Earphones, Speakers, Keyboards or Gamepads Simultaneously, Plug & Play for Windows 10/11",
                icon: '📶',
                images: [
                    'https://m.media-amazon.com/images/I/61yB3b6s5kL._AC_SL1500_.jpg'
                ]
            },
            {
                id: 'PROD-ACC-G01',
                name: "Wired USB Controller for Xbox 360 & Windows PC",
                category: 'Accessories',
                price: 100,
                stock: 25,
                spec: "Compatibility: Xbox 360, Windows PC (11/10/8/7), Steam Gaming, Connection: 2.2m Wired USB with Breakaway Cable, Features: Dual Vibration Force Feedback Motors, Precision 8-Directional D-Pad, 2 Pressure-Point Analog Triggers, Ergonomic Comfort Design",
                icon: '🎮',
                images: [
                    'https://images.unsplash.com/photo-1600080972464-8e5f35f63d08?w=600&auto=format&fit=crop&q=80'
                ]
            },
            {
                id: 'PROD-ACC-G02',
                name: "Dual Double-Motor Vibration Wireless Game Controller (PS4 / PC)",
                category: 'Accessories',
                price: 150,
                stock: 20,
                spec: "Compatibility: PlayStation 4 (PS4, PS4 Slim, PS4 Pro) & PC / Laptop / Mobile, Features: Dual High-Torque Rumble Vibration Motors, Highly Responsive Multi-Touch Clickable Touchpad, 6-Axis Motion Gyroscope, Built-in Speaker & 3.5mm Stereo Audio Jack, Rechargeable",
                icon: '🎮',
                images: [
                    'https://images.unsplash.com/photo-1592840496694-26d035b52b48?w=600&auto=format&fit=crop&q=80'
                ]
            },
            {
                id: 'PROD-ACC-KB01',
                name: "T-Wolf TF100 2.4GHz Wireless Keyboard & Mouse Combo",
                category: 'Accessories',
                price: 200,
                stock: 20,
                spec: "Brand: T-Wolf, Model: TF100, Connectivity: 2.4GHz Wireless (Single USB Dongle for Both), Keyboard: Full Size 104-Key Layout with Low-Profile Quiet Keys, Spill-Resistant Architecture, Mouse: Ergonomic 1600 DPI Optical Sensor, Long Battery Life with Smart Sleep Mode",
                icon: '⌨️',
                images: [
                    'https://manuals.plus/asin/B0922ZYXJ9.jpg'
                ]
            },
            {
                id: 'PROD-ACC-KB02',
                name: "T-Wolf TF200 Rainbow Backlit Wired Gaming Keyboard & Mouse Set",
                category: 'Accessories',
                price: 200,
                stock: 20,
                spec: "Brand: T-Wolf, Model: TF200, Connectivity: High-Speed Wired USB, Keyboard: Mechanical-Feel Suspended Keycaps, Vibrant Rainbow RGB LED Backlighting, 19-Key Anti-Ghosting, Mouse: 4-Button Ergonomic RGB Gaming Optical Mouse with Dedicated DPI Adjustment (800-2400 DPI)",
                icon: '⌨️',
                images: [
                    'https://images.unsplash.com/photo-1541140532154-b024d705b909?w=600&auto=format&fit=crop&q=80'
                ]
            },
            {
                id: 'PROD-ACC-KB03',
                name: "VONN VON 15 Wired Desktop Keyboard & Optical Mouse Set",
                category: 'Accessories',
                price: 150,
                stock: 25,
                spec: "Brand: VONN, Model: VON 15, Connectivity: Dual USB Wired Interface, Keyboard: Full-size Standard Office Layout with Dedicated Numeric Pad, UV Coated Wear-Resistant Lettering, Spill-Drain Channels, Mouse: Smooth High Precision 1200 DPI Optical Engine",
                icon: '⌨️',
                images: [
                    'https://m.media-amazon.com/images/I/71X8k-24iSL._AC_SL1500_.jpg'
                ]
            },
            // ── Apple MacBook Chargers ──
            {
                id: 'PROD-CHG-MAC01',
                name: "Apple MacBook MagSafe 1 Power Adapter Charger (45W)",
                category: 'Accessories',
                price: 200,
                stock: 20,
                spec: "Connector: MagSafe 1 (Magnetic L-Tip / T-Tip), Wattage: 45W (Compatible with MacBook Air 11\"/13\" 2008-2011 models), LED Charging Indicator, Magnetic Safety Breakaway",
                icon: '🍏',
                images: [
                    'https://m.media-amazon.com/images/I/51V1A0p3MCL._AC_SL1500_.jpg'
                ]
            },
            {
                id: 'PROD-CHG-MAC03',
                name: "Apple MacBook MagSafe 1 Power Adapter Charger (60W)",
                category: 'Accessories',
                price: 250,
                stock: 20,
                spec: "Connector: MagSafe 1 (Magnetic L-Tip / T-Tip), Wattage: 60W (Compatible with MacBook Pro 13\" 2009-2012 models & MacBook 13\" Unibody), LED Charging Indicator, Magnetic Safety Breakaway",
                icon: '🍏',
                images: [
                    'https://m.media-amazon.com/images/I/51V1A0p3MCL._AC_SL1500_.jpg'
                ]
            },
            {
                id: 'PROD-CHG-MAC04',
                name: "Apple MacBook MagSafe 1 Power Adapter Charger (85W)",
                category: 'Accessories',
                price: 350,
                stock: 20,
                spec: "Connector: MagSafe 1 (Magnetic L-Tip / T-Tip), Wattage: 85W (Compatible with MacBook Pro 15\" and 17\" 2006-2012 models), High Power Fast Charge, Magnetic Safety Breakaway",
                icon: '🍏',
                images: [
                    'https://m.media-amazon.com/images/I/51V1A0p3MCL._AC_SL1500_.jpg'
                ]
            },
            {
                id: 'PROD-CHG-MAC02',
                name: "Apple MacBook MagSafe 2 Power Adapter Charger (45W)",
                category: 'Accessories',
                price: 250,
                stock: 20,
                spec: "Connector: MagSafe 2 (Slim Magnetic T-Tip), Wattage: 45W (Compatible with MacBook Air 11\"/13\" 2012-2017 models), High Grade Protected Output",
                icon: '🍏',
                images: [
                    'https://images.unsplash.com/photo-1611186871348-b1ce696e52c9?w=600&auto=format&fit=crop&q=80'
                ]
            },
            {
                id: 'PROD-CHG-MAC05',
                name: "Apple MacBook MagSafe 2 Power Adapter Charger (60W)",
                category: 'Accessories',
                price: 300,
                stock: 20,
                spec: "Connector: MagSafe 2 (Slim Magnetic T-Tip), Wattage: 60W (Compatible with MacBook Pro Retina 13\" Late 2012 - Early 2015 models), LED Status Indicator, High Grade Protected Output",
                icon: '🍏',
                images: [
                    'https://images.unsplash.com/photo-1611186871348-b1ce696e52c9?w=600&auto=format&fit=crop&q=80'
                ]
            },
            {
                id: 'PROD-CHG-MAC06',
                name: "Apple MacBook MagSafe 2 Power Adapter Charger (85W)",
                category: 'Accessories',
                price: 400,
                stock: 20,
                spec: "Connector: MagSafe 2 (Slim Magnetic T-Tip), Wattage: 85W (Compatible with MacBook Pro Retina 15\" Mid 2012 - Mid 2015 models), Heavy Duty Output, Multi-Protection Circuit",
                icon: '🍏',
                images: [
                    'https://images.unsplash.com/photo-1611186871348-b1ce696e52c9?w=600&auto=format&fit=crop&q=80'
                ]
            },
            // ── HP Chargers ──
            {
                id: 'PROD-CHG-001',
                name: "HP 90W Blue Pin Smart AC Laptop Charger Adapter (19.5V 4.62A)",
                category: 'Accessories',
                price: 150,
                stock: 30,
                spec: "Brand: HP Compatible OEM, Output: 19.5V 4.62A (90W - fully backwards compatible with 65W & 45W), Connector Tip: 4.5mm x 3.0mm Blue Tip Center Pin, Built-in Over-Current, Over-Voltage & Short Circuit Protection, Fits HP Pavilion, Envy, ProBook, EliteBook",
                icon: '🔌',
                images: [
                    'https://m.media-amazon.com/images/I/61o6U3-qD2L._AC_SL1500_.jpg'
                ]
            },
            // ── Dell Chargers ──
            {
                id: 'PROD-CHG-006',
                name: "Dell 65W / 90W Small Pin AC Laptop Charger (4.5mm x 3.0mm Tip)",
                category: 'Accessories',
                price: 150,
                stock: 30,
                spec: "Brand: Dell OEM Replacement, Output: 19.5V 3.34A / 4.62A (65W/90W), Connector: 4.5mm x 3.0mm Small Barrel with Center Smart Pin, Compatible with Dell Inspiron, XPS 13, Latitude 3000/5000/7000 series, Vostro",
                icon: '🔌',
                images: [
                    'https://m.media-amazon.com/images/I/61r5hGq1sEL._AC_SL1500_.jpg'
                ]
            },
            {
                id: 'PROD-CHG-007',
                name: "Dell 90W Big Pin AC Laptop Charger Adapter (7.4mm x 5.0mm Tip)",
                category: 'Accessories',
                price: 150,
                stock: 25,
                spec: "Brand: Dell OEM Replacement, Output: 19.5V 4.62A (90W), Connector: 7.4mm x 5.0mm Large Barrel with Center Smart Pin, Compatible with Dell Latitude E6420, E6430, E6440, E5440, E5540, Inspiron, Precision Workstations",
                icon: '🔌',
                images: [
                    'https://m.media-amazon.com/images/I/61hX0V1N8-L._AC_SL1500_.jpg'
                ]
            },
            // ── Lenovo Chargers ──
            {
                id: 'PROD-CHG-004',
                name: "Lenovo 65W / 90W Yellow Rectangular Square USB-Pin Laptop Charger",
                category: 'Accessories',
                price: 150,
                stock: 25,
                spec: "Brand: Lenovo OEM Replacement, Output: 20V 3.25A / 4.5A (65W/90W), Connector: Yellow Square USB-Style Tip with Center Pin, Compatible with Lenovo ThinkPad T440, T450, T460, T470, X240, X250, X260, IdeaPad, Yoga",
                icon: '🔌',
                images: [
                    'https://m.media-amazon.com/images/I/61Xq0sX0zAL._AC_SL1500_.jpg'
                ]
            },
            {
                id: 'PROD-CHG-008',
                name: "Lenovo 90W Big Round Pin AC Laptop Charger Adapter (7.9mm x 5.5mm Tip)",
                category: 'Accessories',
                price: 100,
                stock: 20,
                spec: "Brand: Lenovo OEM Replacement, Output: 20V 4.5A (90W) / 3.25A (65W), Connector: 7.9mm x 5.5mm Round Tip with Center Pin, Compatible with Classic Lenovo ThinkPad T60, T61, T400, T410, T420, T430, X220, X230, W500",
                icon: '🔌',
                images: [
                    'https://m.media-amazon.com/images/I/61bW6m0NlCL._AC_SL1500_.jpg'
                ]
            },
            // ── Acer Chargers ──
            {
                id: 'PROD-CHG-005',
                name: "Acer Aspire 19V Laptop AC Power Adapter Charger (5.5mm x 1.7mm)",
                category: 'Accessories',
                price: 100,
                stock: 20,
                spec: "Brand: Acer OEM Replacement, Output: 19V 3.42A (65W) / 19V 2.37A (45W), Connector Tip: 5.5mm x 1.7mm (Purple/Blue tip), Compatible with Acer Aspire 3, Aspire 5, TravelMate, Swift & Extensa series",
                icon: '🔌',
                images: [
                    'https://m.media-amazon.com/images/I/61s8B4X4OML._AC_SL1500_.jpg'
                ]
            },
            // ── Toshiba Chargers ──
            {
                id: 'PROD-CHG-003',
                name: "Toshiba Satellite 19V AC Power Adapter Laptop Charger (5.5mm x 2.5mm)",
                category: 'Accessories',
                price: 100,
                stock: 20,
                spec: "Brand: Toshiba OEM Replacement, Output: 19V 3.42A / 3.95A (65W / 75W), Connector Tip: 5.5mm x 2.5mm Barrel, Compatible with Toshiba Satellite, Dynabook, Asus, Lenovo & Universal 19V Laptop Models",
                icon: '🔌',
                images: [
                    'https://m.media-amazon.com/images/I/61H4bX2mBTL._AC_SL1500_.jpg'
                ]
            },
            // ── Universal Type-C Chargers ──
            {
                id: 'PROD-CHG-002',
                name: "Universal 65W / 90W Type-C USB-C PD Fast Laptop Charger Adapter",
                category: 'Accessories',
                price: 350,
                stock: 20,
                spec: "Technology: USB-C Power Delivery (PD 3.0 Fast Charge), Smart Output: Auto-Switching 5V/9V/12V/15V/20V (up to 65W/90W), Compatible with HP Type-C, Dell XPS/Latitude Type-C, Lenovo ThinkPad/Yoga, MacBook Pro/Air, Asus, Acer, Surface & Type-C Tablets/Phones",
                icon: '🔌',
                images: [
                    'https://images.unsplash.com/photo-1583863788434-e58a36330cf0?w=600&auto=format&fit=crop&q=80'
                ]
            },
            {
                id: 'PROD-CAB-001',
                name: "Heavy Duty 3-Pin UK Plug PC & Monitor Power Cable (1.5m)",
                category: 'Accessories',
                price: 30,
                stock: 50,
                spec: "Plug Type: UK Standard 3-Pin Fused Plug (13A Fused), Connector: IEC C13 Standard Kettle Lead / Cloverleaf C5 option, Length: 1.5m, Heavy Duty Pure Copper Wiring, Compatible with Desktop PCs, Monitors, Laptop Power Bricks, Printers, Projectors",
                icon: '🔌',
                images: [
                    'https://m.media-amazon.com/images/I/61K-31k2xFL._AC_SL1500_.jpg'
                ]
            },
            {
                id: 'PROD-CAB-002',
                name: "High-Speed USB 2.0 Type-A to Type-B Printer Cable (1.5m)",
                category: 'Accessories',
                price: 30,
                stock: 40,
                spec: "Interface: USB 2.0 Type-A Male to Type-B Male, Transfer Speed: Up to 480Mbps, Foil & Braid Shielding for Error-Free Data Transmission, Compatible with HP, Canon, Epson, Brother, Samsung Printers & Scanners",
                icon: '🖨️',
                images: [
                    'https://m.media-amazon.com/images/I/61m1hQyJVAL._AC_SL1500_.jpg'
                ]
            },
            {
                id: 'PROD-CAB-003',
                name: "Gold-Plated 15-Pin Male-to-Male Full HD VGA Cable (1.5m)",
                category: 'Accessories',
                price: 35,
                stock: 40,
                spec: "Connector: 15-Pin SVGA/VGA Male to Male with Dual Ferrite Anti-Interference Cores, Resolution: Supports 1080p Full HD Display, Gold-Plated Connectors, Heavy Duty PVC Jacket, Compatible with PC, Laptops, Monitors, Projectors & Splitters",
                icon: '🖥️',
                images: [
                    'https://m.media-amazon.com/images/I/61Q6qQyJVAL._AC_SL1500_.jpg'
                ]
            },
            {
                id: 'PROD-CAB-004',
                name: "Cat6 RJ45 Gigabit High-Speed Ethernet Network Patch Cable",
                category: 'Networking',
                price: 35,
                stock: 60,
                spec: "Standard: Category 6 UTP Patch Cable, Speed: 1000Mbps (Gigabit Ethernet) / 250MHz Bandwidth, Gold-Plated 8P8C RJ45 Snagless Connectors, Compatible with Routers, Modems, Laptops, Desktops, CCTV, Starlink & Network Switches",
                icon: '🌐',
                images: [
                    'https://images.unsplash.com/photo-1544197150-b99a580bb7a8?w=600&auto=format&fit=crop&q=80'
                ]
            },
            {
                id: 'PROD-CAB-005',
                name: "High-Speed 4K Ultra HD HDMI Cable (1m / 2m / 5m)",
                category: 'Accessories',
                price: 40,
                priceDisplay: "GH₵ 40 – 100",
                stock: 50,
                spec: "Standard: HDMI 2.0 High Speed with Ethernet, Resolution: Supports 4K Ultra HD @ 60Hz, 3D, Audio Return Channel (ARC), 24K Gold-Plated Connectors with Multi-Layer Shielding. Available Lengths: 1 Meter (GH₵40), 2 Meters (GH₵60), 5 Meters (GH₵100)",
                icon: '📺',
                images: [
                    'https://m.media-amazon.com/images/I/61c8sFqL3TL._AC_SL1500_.jpg'
                ]
            },
            {
                id: 'PROD-HDD-001',
                name: "500GB 2.5\" SATA Internal Laptop Hard Disk Drive (HDD)",
                category: 'Storage',
                price: 200,
                stock: 25,
                spec: "Capacity: 500GB, Form Factor: 2.5 inch SATA III (6Gb/s), Speed: 5400/7200 RPM, 100% Health Tested with 0 Bad Sectors, Ideal for Laptop Storage Expansion, Secondary Drive or External Enclosure Use",
                icon: '💽',
                images: [
                    'https://images.unsplash.com/photo-1531492746076-161ca9bcad58?w=600&auto=format&fit=crop&q=80'
                ]
            },
            {
                id: 'PROD-SSD-001',
                name: "256GB High-Speed SSD Solid State Drive Upgrade (SATA / NVMe)",
                category: 'Storage',
                price: 350,
                stock: 30,
                spec: "Form Factor: 2.5\" SATA III / M.2 NVMe PCIe, Capacity: 256GB, Read Speed: up to 550MB/s (SATA) / 2400MB/s (NVMe), Instant Boot & 10x Faster Than Traditional Hard Drives, Low Power Consumption, Shock Resistant, Professional Installation & Data Migration Available",
                icon: '💿',
                images: [
                    'https://images.unsplash.com/photo-1597872200969-2b65d56bd16b?w=600&auto=format&fit=crop&q=80'
                ]
            },
            {
                id: 'PROD-SSD-002',
                name: "512GB High-Speed SSD Solid State Drive Upgrade (SATA / NVMe)",
                category: 'Storage',
                price: 700,
                stock: 25,
                spec: "Form Factor: 2.5\" SATA III / M.2 NVMe PCIe Gen 3, Capacity: 512GB, Read Speed: up to 560MB/s (SATA) / 3200MB/s (NVMe), Write Speed: up to 520MB/s, Blazing Fast Multitasking & Large Capacity for Software, Games and Projects, Professional Installation Available",
                icon: '💿',
                images: [
                    'https://images.unsplash.com/photo-1597872200969-2b65d56bd16b?w=600&auto=format&fit=crop&q=80'
                ]
            },
            {
                id: 'PROD-SSD-003',
                name: "1TB Ultra-Fast High Capacity SSD Solid State Drive Upgrade (SATA / NVMe)",
                category: 'Storage',
                price: 1400,
                stock: 20,
                spec: "Form Factor: 2.5\" SATA III / M.2 NVMe PCIe Gen 3x4, Capacity: 1TB (1000GB), Read Speed: up to 3500MB/s, Write Speed: up to 3000MB/s, Maximum Performance & Massive Storage Capacity for Video Creators, Developers & Gamers, Professional Installation Available",
                icon: '💿',
                images: [
                    'https://images.unsplash.com/photo-1597872200969-2b65d56bd16b?w=600&auto=format&fit=crop&q=80'
                ]
            },
            {
                id: 'PROD-ACC-CASE01',
                name: "M.2 SATA (NGFF) SSD External Aluminum Enclosure Case (USB 3.1)",
                category: 'Accessories',
                price: 200,
                stock: 25,
                spec: "Compatibility: M.2 SATA (B-Key & B+M Key) SSDs (Sizes 2230/2242/2260/2280), Interface: High-Speed USB 3.1 Gen 1 (up to 5Gbps), Premium Aluminum Alloy Shell for Rapid Heat Dissipation, Tool-Free Installation, Transform your Internal M.2 SSD into a Pocket Portable Drive",
                icon: '🗄️',
                images: [
                    'https://m.media-amazon.com/images/I/61y8B3q9YKL._AC_SL1500_.jpg'
                ]
            },
            {
                id: 'PROD-ACC-CASE02',
                name: "Dual-Protocol M.2 NVMe & SATA SSD External Aluminum Enclosure Case (10Gbps USB-C)",
                category: 'Accessories',
                price: 250,
                stock: 25,
                spec: "Dual Protocol Support: Compatible with Both M.2 NVMe (PCIe M-Key / B+M Key) & M.2 SATA (NGFF) SSDs, High Speed: USB 3.2 Gen 2 Type-C (up to 10Gbps / 1000MB/s real-world transfer speed), Aluminum Body with Thermal Silicone Pad, Includes USB-C & USB-A Cables",
                icon: '🗄️',
                images: [
                    'https://m.media-amazon.com/images/I/61u9Z3r3XTL._AC_SL1500_.jpg'
                ]
            },
            {
                id: 'PROD-PART-BAT01',
                name: "Replacement Inbuilt Laptop Battery (HP, Dell, Lenovo, Acer, Asus)",
                category: 'Parts',
                price: 300,
                priceDisplay: "GH₵ 300 – 400",
                stock: 25,
                spec: "Type: High Grade Li-ion / Li-Polymer Internal Inbuilt Laptop Battery, Grade-A Japanese/Korean Battery Cells, Multi-Protection Circuit (Overcharge, Over-discharge, Overheating & Short Circuit), Price ranges GH₵300 - GH₵400 depending on exact laptop model",
                icon: '🔋',
                images: [
                    'https://m.media-amazon.com/images/I/61lX2q4HkML._AC_SL1500_.jpg'
                ]
            },
            {
                id: 'PROD-PART-BAT02',
                name: "Replacement External Clip-On Laptop Battery",
                category: 'Parts',
                price: 200,
                priceDisplay: "GH₵ 200 – 350",
                stock: 25,
                spec: "Type: External Removable Clip-on Laptop Battery for Dell Latitude, HP ProBook / EliteBook, Lenovo ThinkPad & Toshiba laptops, High Capacity 6-Cell / 9-Cell options, Long-lasting backup time. Price ranges GH₵200 - GH₵350 depending on laptop model",
                icon: '🔋',
                images: [
                    'https://m.media-amazon.com/images/I/61h3P4q1vAL._AC_SL1500_.jpg'
                ]
            },
            {
                id: 'PROD-PART-KB01',
                name: "Replacement Laptop OEM Internal Keyboard",
                category: 'Parts',
                price: 100,
                priceDisplay: "GH₵ 100 – 350",
                stock: 30,
                spec: "Type: OEM Internal Replacement Keyboard for HP, Dell, Lenovo, Toshiba, Acer, Asus laptops. Available in Backlit and Non-Backlit variants with standard US Layout. Professional installation available. Price ranges GH₵100 - GH₵350 depending on model",
                icon: '⌨️',
                images: [
                    'https://m.media-amazon.com/images/I/71Y8K9l4OLL._AC_SL1500_.jpg'
                ]
            },
            {
                id: 'PROD-PART-SCR01',
                name: "Laptop LED / LCD Screen Replacement Panel (HD / FHD / Touch)",
                category: 'Parts',
                price: 350,
                priceDisplay: "GH₵ 350 – 1,900",
                stock: 25,
                spec: "Type: Grade-A+ Brand New Replacement Laptop Screen Display (11.6\", 13.3\", 14.0\", 15.6\", 17.3\"), Slim 30-Pin / 40-Pin eDP Interface, HD / Full HD IPS / Touchscreen Options Available, 0 Dead Pixels, Professional Same-Day Installation Available. Price ranges GH₵350 - GH₵1,900",
                icon: '🖥️',
                images: [
                    'https://m.media-amazon.com/images/I/71w1B5q8kPL._AC_SL1500_.jpg'
                ]
            }
        ];

        this.defaultProductsList = defaultProducts;

        const defaultUsers = [];

        const defaultOrders = [];

        const defaultHP = [];

        const defaultPromos = [
            {
                id: 'PROMO-20OFF',
                scope: 'category',
                category: 'Laptops',
                type: 'percent',
                value: 20
            }
        ];

        const defaultFeaturedLaptops = [
            {
                slot: 1,
                productId: 'PROD-001',
                brand: 'HP',
                title: 'Hp Zbook 15u G6',
                specs: 'Core i7 | 32GB RAM\n1TB SSD | 15.6" FHD',
                heroLabel: 'HP WORKSTATION',
                price: 8750,
                image: 'images/products/PROD-001/1.jpg'
            },
            {
                slot: 2,
                productId: 'PROD-018',
                brand: 'HP',
                title: 'Hp Elitebook 840 G8',
                specs: 'Core i7 | 32GB RAM\n512GB SSD | 14.0" FHD',
                heroLabel: 'HP FLAGSHIP',
                price: 7875,
                image: 'images/products/PROD-018/1.jpg'
            },
            {
                slot: 3,
                productId: 'PROD-022',
                brand: 'DELL',
                title: 'Dell Latitude 7420',
                specs: 'Core i5 | 16GB RAM\n512GB SSD | 13.3" FHD',
                heroLabel: 'DELL BUSINESS',
                price: 5625,
                image: 'images/products/PROD-022/1.jpg'
            },
            {
                slot: 4,
                productId: 'PROD-023',
                brand: 'Lenovo',
                title: 'Lenovo Thinkpad T480s',
                specs: 'Core i5 | 16GB RAM\n256GB SSD | 14.0" FHD',
                heroLabel: 'LENOVO THINKPAD',
                price: 3600,
                image: 'images/products/PROD-023/1.jpg'
            }
        ];

        // Check if database reset or cross-device sync migration is needed
        const CURRENT_CATALOG_VERSION = 'v4.6_20261008';
        const localVersion = safeLocalStorage.getItem('kmap_catalog_version');
        const existingProducts = safeLocalStorage.getItem('kmap_products');
        let needsReset = false;
        const versionMismatch = localVersion !== CURRENT_CATALOG_VERSION;

        if (existingProducts) {
            try {
                let parsed = JSON.parse(existingProducts);
                if (!Array.isArray(parsed) || parsed.length === 0) {
                    needsReset = true;
                } else {
                    let modified = versionMismatch;

                    // Ensure all products have images array
                    parsed.forEach(p => {
                        if (!Array.isArray(p.images)) p.images = [];
                    });

                    // Ensure all replacement items are under Parts and MacBook chargers have no range display
                    parsed.forEach(p => {
                        if (p.name && p.name.toLowerCase().includes('replacement') && p.category !== 'Parts') {
                            p.category = 'Parts';
                            modified = true;
                        }
                        if (p.id && p.id.startsWith('PROD-CHG-MAC') && p.priceDisplay) {
                            delete p.priceDisplay;
                            modified = true;
                        }
                    });

                    // Sync & update default catalog items without overwriting user-configured categories or user-uploaded photos
                    defaultProducts.forEach(defProd => {
                        const existing = parsed.find(p => p.id === defProd.id);
                        if (!existing) {
                            parsed.push(defProd);
                            modified = true;
                        } else {
                            const priceDisplayChanged = existing.priceDisplay !== defProd.priceDisplay;
                            if (existing.price !== defProd.price || existing.name !== defProd.name || existing.spec !== defProd.spec || priceDisplayChanged) {
                                existing.price = defProd.price;
                                if (defProd.priceDisplay !== undefined) {
                                    existing.priceDisplay = defProd.priceDisplay;
                                } else {
                                    delete existing.priceDisplay;
                                }
                                existing.name = defProd.name;
                                existing.spec = defProd.spec;
                                if (!existing.category) {
                                    existing.category = defProd.category;
                                }
                                modified = true;
                            }
                            // Only set default images if item has never been customized by user and has no images
                            if (!existing.customImages && (!existing.images || existing.images.length === 0)) {
                                existing.images = defProd.images || [];
                                modified = true;
                            }
                        }
                    });

                    // Re-order parsed products so all like chargers and items appear in clean succession
                    parsed = this.sortProductList(parsed);
                    modified = true;

                    if (modified || versionMismatch) {
                        safeLocalStorage.setItem('kmap_products', JSON.stringify(parsed));
                        safeLocalStorage.setItem('kmap_catalog_version', CURRENT_CATALOG_VERSION);
                        setTimeout(() => this.forceCloudSyncAll(true), 600);
                    }
                }
            } catch (e) {
                needsReset = true;
            }
        } else {
            needsReset = true;
        }

        if (needsReset) {
            safeLocalStorage.setItem('kmap_products', JSON.stringify(defaultProducts), true);
            safeLocalStorage.setItem('kmap_users', JSON.stringify(defaultUsers), true);
            safeLocalStorage.setItem('kmap_orders', JSON.stringify(defaultOrders), true);
            safeLocalStorage.setItem('kmap_logs', JSON.stringify([]), true);
            safeLocalStorage.setItem('kmap_promos', JSON.stringify(defaultPromos), true);
            safeLocalStorage.setItem('kmap_hire_purchase', JSON.stringify(defaultHP), true);
            safeLocalStorage.setItem('kmap_featured_laptops', JSON.stringify(defaultFeaturedLaptops), true);
        }

        if (!safeLocalStorage.getItem('kmap_featured_laptops')) {
            safeLocalStorage.setItem('kmap_featured_laptops', JSON.stringify(defaultFeaturedLaptops), true);
        }

        // Clean out any legacy seeded test orders, hire purchases, and test client accounts from local storage & cloud
        try {
            const currentOrders = JSON.parse(safeLocalStorage.getItem('kmap_orders') || '[]');
            const cleanedOrders = currentOrders.filter(o => o.id !== 'ORD-8932' && o.id !== 'ORD-7612' && o.clientName !== 'Kwame Mensah' && o.clientName !== 'Ama Serwaa');
            if (cleanedOrders.length !== currentOrders.length || !safeLocalStorage.getItem('kmap_orders')) {
                safeLocalStorage.setItem('kmap_orders', JSON.stringify(cleanedOrders));
            }
        } catch (e) {
            safeLocalStorage.setItem('kmap_orders', JSON.stringify([]));
        }

        try {
            const currentHP = JSON.parse(safeLocalStorage.getItem('kmap_hire_purchase') || '[]');
            const cleanedHP = currentHP.filter(h => h.id !== 'HP-001' && h.clientName !== 'Kwame Mensah');
            if (cleanedHP.length !== currentHP.length || !safeLocalStorage.getItem('kmap_hire_purchase')) {
                safeLocalStorage.setItem('kmap_hire_purchase', JSON.stringify(cleanedHP));
            }
        } catch (e) {
            safeLocalStorage.setItem('kmap_hire_purchase', JSON.stringify([]));
        }

        try {
            const currentUsers = JSON.parse(safeLocalStorage.getItem('kmap_users') || '[]');
            let cleanedUsers = currentUsers.filter(u => u.username !== '0241234567' && u.name !== 'Kwame Mensah' && u.username !== 'superadmin');
            safeLocalStorage.setItem('kmap_users', JSON.stringify(cleanedUsers));
        } catch (e) {
            safeLocalStorage.setItem('kmap_users', JSON.stringify([]));
        }

        this.db = {
            getProducts: () => {
                try {
                    const p = JSON.parse(safeLocalStorage.getItem('kmap_products'));
                    const list = (Array.isArray(p) && p.length > 0) ? p : defaultProducts;
                    return this.sortProductList(list);
                } catch (e) {
                    return this.sortProductList(defaultProducts);
                }
            },
            saveProducts: (data) => {
                const sorted = this.sortProductList(data);
                safeLocalStorage.setItem('kmap_products', JSON.stringify(sorted));
            },
            getUsers: () => {
                try {
                    const u = JSON.parse(safeLocalStorage.getItem('kmap_users'));
                    return (Array.isArray(u) && u.length > 0) ? u : defaultUsers;
                } catch (e) {
                    return defaultUsers;
                }
            },
            saveUsers: (data) => safeLocalStorage.setItem('kmap_users', JSON.stringify(data)),
            getOrders: () => {
                try {
                    const o = JSON.parse(safeLocalStorage.getItem('kmap_orders'));
                    return Array.isArray(o) ? o : [];
                } catch (e) {
                    return [];
                }
            },
            saveOrders: (data) => safeLocalStorage.setItem('kmap_orders', JSON.stringify(data)),
            getLogs: () => JSON.parse(safeLocalStorage.getItem('kmap_logs')),
            addLog: (msg) => {
                const logs = JSON.parse(safeLocalStorage.getItem('kmap_logs')) || [];
                logs.unshift({ date: new Date().toISOString(), user: this.currentUser?.username || 'System', message: msg });
                safeLocalStorage.setItem('kmap_logs', JSON.stringify(logs));
            },
            getPromos: () => {
                try {
                    const p = JSON.parse(safeLocalStorage.getItem('kmap_promos'));
                    return (Array.isArray(p) && p.length > 0) ? p : defaultPromos;
                } catch (e) {
                    return defaultPromos;
                }
            },
            savePromos: (data) => safeLocalStorage.setItem('kmap_promos', JSON.stringify(data)),
            getHP: () => JSON.parse(safeLocalStorage.getItem('kmap_hire_purchase')) || [],
            saveHP: (data) => safeLocalStorage.setItem('kmap_hire_purchase', JSON.stringify(data)),
            getFeaturedLaptops: () => {
                try {
                    const f = JSON.parse(safeLocalStorage.getItem('kmap_featured_laptops'));
                    return (Array.isArray(f) && f.length > 0) ? f.slice(0, 4) : defaultFeaturedLaptops;
                } catch (e) {
                    return defaultFeaturedLaptops;
                }
            },
            saveFeaturedLaptops: (data) => {
                const capped = (data || []).slice(0, 4);
                safeLocalStorage.setItem('kmap_featured_laptops', JSON.stringify(capped));
                return capped;
            }
        };
    }

    bindEvents() {
        // Handle Unified Login Form via Server Authentication
        document.getElementById('login-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            const usernameInput = document.getElementById('login-username').value.trim();
            const pass = document.getElementById('login-password').value.trim();
            const submitBtn = e.target.querySelector('button[type="submit"]');
            const err = document.getElementById('login-error-msg');
            if (err) err.style.display = 'none';

            if (submitBtn) {
                submitBtn.disabled = true;
                submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Authenticating...';
            }

            try {
                const res = await fetch(getAuthApiUrl(), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: 'login', username: usernameInput, password: pass })
                });
                const data = await res.json().catch(() => ({}));

                if (res.ok && data.success && data.user && data.token) {
                    safeLocalStorage.setItem('kmap_auth_token', data.token);
                    safeLocalStorage.setItem('kmap_current_user', JSON.stringify(data.user));
                    this.currentUser = data.user;
                    this.loadCart();
                    this.closeLoginModal();

                    // Set Header Profile
                    this.updateProfileHeader(data.user);
                    this.renderSidebar();
                    this.syncDownstream();

                    if (data.user.role === 'client') {
                        this.switchView('landing-page');
                    } else {
                        this.switchView('admin-dashboard');
                    }
                    this.showToast(`Welcome back, ${data.user.name || data.user.username}!`);
                } else {
                    if (err) {
                        err.innerText = data.error || "Invalid credentials. Please check details.";
                        err.style.display = 'block';
                    }
                }
            } catch (netErr) {
                if (err) {
                    err.innerText = "Connection failed. Please check network.";
                    err.style.display = 'block';
                }
            } finally {
                if (submitBtn) {
                    submitBtn.disabled = false;
                    submitBtn.innerHTML = 'Sign In';
                }
            }
        });

        // Toggle Login / Signup Forms (Safeguarded fallback)
        const linkShowSignup = document.getElementById('link-show-signup');
        if (linkShowSignup) {
            linkShowSignup.addEventListener('click', (e) => {
                e.preventDefault();
                this.showAuthTab('signup');
            });
        }

        const linkShowLogin = document.getElementById('link-show-login');
        if (linkShowLogin) {
            linkShowLogin.addEventListener('click', (e) => {
                e.preventDefault();
                this.showAuthTab('signin');
            });
        }

        // Handle Signup Form Submit via Server Registration
        document.getElementById('signup-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            const name = document.getElementById('signup-name').value.trim();
            const username = document.getElementById('signup-username').value.trim();
            const pass = document.getElementById('signup-password').value.trim();
            const submitBtn = e.target.querySelector('button[type="submit"]');
            const err = document.getElementById('login-error-msg');
            if (err) err.style.display = 'none';

            if (submitBtn) {
                submitBtn.disabled = true;
                submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Registering...';
            }

            try {
                const res = await fetch(getAuthApiUrl(), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: 'signup', name, username, password: pass })
                });
                const data = await res.json().catch(() => ({}));

                if (res.ok && data.success && data.user && data.token) {
                    safeLocalStorage.setItem('kmap_auth_token', data.token);
                    safeLocalStorage.setItem('kmap_current_user', JSON.stringify(data.user));
                    this.currentUser = data.user;
                    this.loadCart();
                    this.closeLoginModal();

                    this.updateProfileHeader(data.user);
                    this.renderSidebar();
                    this.switchView('landing-page');
                    this.showToast(`Welcome, ${name}! Your account has been registered.`);
                    document.getElementById('signup-form').reset();
                } else {
                    if (err) {
                        err.innerText = data.error || "Signup failed. Please try again.";
                        err.style.display = 'block';
                    }
                }
            } catch (netErr) {
                if (err) {
                    err.innerText = "Connection error during signup.";
                    err.style.display = 'block';
                }
            } finally {
                if (submitBtn) {
                    submitBtn.disabled = false;
                    submitBtn.innerHTML = 'Register';
                }
            }
        });

        // Handle Guest Browse Button
        const guestBtn = document.getElementById('btn-guest-browse');
        if (guestBtn) {
            guestBtn.addEventListener('click', () => {
                this.closeLoginModal();
            });
        }

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

        // Browser navigation integration ("the web ones" - native back/forward buttons)
        window.addEventListener('popstate', (e) => {
            const targetView = (e.state && e.state.view) || (window.location.hash ? window.location.hash.replace('#', '') : 'landing-page');
            if (targetView && document.getElementById(`view-${targetView}`)) {
                this.switchView(targetView, false);
            }
        });

        // Listen to storage changes for actual real-time order notifications and instant cross-tab sync
        window.addEventListener('storage', (e) => {
            if (e.key === 'kmap_orders') {
                try {
                    const newOrders = JSON.parse(e.newValue || safeLocalStorage.getItem('kmap_orders') || '[]');
                    this.checkOrderNotifications(newOrders);

                    // Refresh views on all tabs instantly
                    this.renderClientOrders();
                    this.renderAdminOrders();
                    this.renderAdminOverview();
                } catch (err) {
                    console.error('Error parsing order updates', err);
                }
            }
            if (e.key === 'kmap_promos' || e.key === 'kmap_products' || e.key === 'kmap_featured_laptops') {
                this.renderClientCatalog();
                this.renderPromotions();
                this.renderCart();
                this.renderAdminInventory();
                this.renderAdminOverview();
                this.renderHomepageFeaturedLaptops();
                this.updateFeaturedPrices();
            }
        });

        window.addEventListener('resize', () => {
            this.renderSidebar();
        });

        // Staff Creation Form
        const createStaffForm = document.getElementById('create-staff-form');
        if (createStaffForm) {
            createStaffForm.addEventListener('submit', async (e) => {
                e.preventDefault();
                const nameInput = document.getElementById('staff-name');
                const user = document.getElementById('staff-username').value.trim();
                const role = document.getElementById('staff-role').value;
                const password = document.getElementById('staff-password').value;
                const name = (nameInput && nameInput.value.trim()) ? nameInput.value.trim() : user.toUpperCase();

                const users = this.db.getUsers();
                if (users.find(u => u.username.toLowerCase() === user.toLowerCase())) {
                    this.showToast("Username already exists! Choose another.", 'error');
                    return;
                }

                const passHash = await this.hashPassword(password);
                const email = user.includes('@') ? user : `${user}@kmapcomputers.com`;
                users.push({ username: user, role, name, email, password: passHash });
                this.db.saveUsers(users);
                this.db.addLog(`Created new user account: ${user} (${role})`);
                this.showToast(`User account ${user} created successfully.`);
                createStaffForm.reset();
                this.renderStaffList();
                this.forceCloudSyncAll(false);
            });
        }

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

            if (this.isProcessingImages) {
                this.showToast('Please wait a moment while photos are optimizing...', 'warning');
                return;
            }

            const images = [];
            document.querySelectorAll('.product-img-url').forEach(input => {
                const val = input.value.trim();
                // Never save temporary blob: URLs into products as they are invalid across page reloads/devices!
                if (val && !val.startsWith('blob:')) {
                    images.push(val);
                }
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
                    p.customImages = true;
                }
                this.db.addLog(`Updated product details for ${name} (${id})`);
                this.showToast(`Product ${name} updated.`);
            } else {
                // Add
                const nextNum = products.length + 1;
                const newId = 'PROD-' + String(nextNum).padStart(3, '0');
                products.push({ id: newId, name, category, price, stock, spec, images, customImages: true, icon: category === 'Laptops' ? '💻' : '🔌' });
                this.db.addLog(`Created new product: ${name} (${newId})`);
                this.showToast(`Product ${name} added.`);
            }
            this.db.saveProducts(products);
            this.closeProductModal();
            this.renderAdminInventory();
            this.forceCloudSyncAll(false);
        });

        // Robust, high-speed photo upload and compression handler
        const fileInput = document.getElementById('form-product-file-upload');
        if (fileInput) {
            fileInput.addEventListener('change', async (e) => {
                const files = Array.from(e.target.files).slice(0, 6);
                if (files.length === 0) return;

                const statusEl = document.getElementById('img-upload-status');
                const submitBtn = document.querySelector('#product-details-form button[type="submit"]');
                const urlInputs = Array.from(document.querySelectorAll('.product-img-url'));

                this.isProcessingImages = true;
                if (submitBtn) {
                    submitBtn.disabled = true;
                    submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Processing Photos...';
                }
                if (statusEl) {
                    statusEl.innerText = `⚡ Optimizing ${files.length} photo(s)...`;
                    statusEl.style.color = 'var(--secondary)';
                }

                // Keep existing photos and append newly uploaded ones
                const existingPhotos = urlInputs.map(input => input.value.trim()).filter(v => v.length > 0);

                try {
                    const compressedList = await Promise.all(files.map(f => this.compressImageFile(f)));
                    const validNew = compressedList.filter(Boolean);

                    // Combine existing photos + newly uploaded photos (up to max slots)
                    const combined = [...existingPhotos, ...validNew];
                    urlInputs.forEach((input, i) => {
                        input.value = combined[i] || '';
                    });

                    if (statusEl) {
                        statusEl.innerText = `✓ ${validNew.length} photo(s) added! (Total: ${Math.min(combined.length, urlInputs.length)})`;
                        statusEl.style.color = 'var(--success)';
                        setTimeout(() => { if (statusEl) statusEl.innerText = ''; }, 3000);
                    }
                } catch (err) {
                    console.error('Image compression failed:', err);
                    if (statusEl) {
                        statusEl.innerText = 'Upload failed: ' + err.message;
                        statusEl.style.color = 'var(--error)';
                    }
                } finally {
                    this.isProcessingImages = false;
                    if (submitBtn) {
                        submitBtn.disabled = false;
                        submitBtn.innerHTML = 'Save Product';
                    }
                    this.refreshModalImagePreviews();
                    fileInput.value = '';
                }
            });
        }

        // Also update previews if someone types/pastes a URL directly
        document.querySelectorAll('.product-img-url').forEach(input => {
            input.addEventListener('input', () => this.refreshModalImagePreviews());
        });

        // Close modals when clicking outside on the backdrop
        document.querySelectorAll('.modal-overlay, .lightbox-overlay').forEach(overlay => {
            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) {
                    this.closeActiveModal(overlay);
                }
            });
        });

        // Touch swipe gestures for fullscreen Lightbox (viewing images one-by-one)
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
                if (Math.abs(diff) > 40) { // Swipe threshold
                    if (diff > 0) {
                        this.prevLightboxImage();
                    } else {
                        this.nextLightboxImage();
                    }
                }
            }, { passive: true });
        }

        // Keyboard navigation (Arrow keys for Lightbox, Escape to close)
        window.addEventListener('keydown', (e) => {
            const lightboxModal = document.getElementById('lightbox-modal');
            const inspectModal = document.getElementById('modal-product-inspect');
            if (lightboxModal && lightboxModal.classList.contains('active')) {
                if (e.key === 'ArrowLeft') this.prevLightboxImage();
                if (e.key === 'ArrowRight') this.nextLightboxImage();
                if (e.key === 'Escape') this.closeLightbox();
            } else if (inspectModal && inspectModal.classList.contains('active')) {
                if (e.key === 'Escape') this.closeInspectModal();
            } else if (e.key === 'Escape') {
                document.querySelectorAll('.modal-overlay.active').forEach(m => m.classList.remove('active'));
                this.updateScrollLock();
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

        // Change Password Form Submission with Email OTP verification
        const changePwForm = document.getElementById('change-password-form');
        if (changePwForm) {
            changePwForm.addEventListener('submit', async (e) => {
                e.preventDefault();
                const otpInput = document.getElementById('form-pw-otp').value.trim();
                const newPw = document.getElementById('form-pw-new').value;
                const confirmPw = document.getElementById('form-pw-confirm').value;

                await this.verifyAndOverridePassword(otpInput, newPw, confirmPw);
            });
        }

        // Close report download dropdown when clicking outside
        document.addEventListener('click', (e) => {
            const dropdown = document.getElementById('report-download-dropdown');
            if (dropdown && !dropdown.contains(e.target)) {
                this.closeReportDownloadDropdown();
            }
        });
    }

    // Switch Application Views
    switchView(viewName, updateBrowserHistory = true) {
        // Auto-close sidebar on view selection
        this.closeSidebar();

        if (updateBrowserHistory && window.history && window.history.pushState) {
            const currentHash = window.location.hash ? window.location.hash.replace('#', '') : '';
            if (currentHash !== viewName) {
                window.history.pushState({ view: viewName }, '', '#' + viewName);
            }
        }

        this.activeView = viewName;

        const viewTitles = {
            'landing-page': 'Kmap Computers | Quality Laptops & Tech | Nationwide Delivery',
            'client-store': 'Shop Laptops, Desktops & Accessories Online | Kmap Computers',
            'client-cart': 'Shopping Cart | Kmap Computers',
            'client-favorites': 'Saved Favorites & Wishlist | Kmap Computers',
            'client-orders': 'My Purchase Orders | Kmap Computers',
            'client-find-us': 'Find Our Shop in Sunyani & Contact Us | Kmap Computers'
        };
        if (viewTitles[viewName]) {
            document.title = viewTitles[viewName];
        } else if (viewName && viewName.startsWith('admin-')) {
            document.title = 'Admin Portal | Kmap Computers';
        }

        document.querySelectorAll('.app-view').forEach(view => view.style.display = 'none');
        document.querySelectorAll('.nav-item').forEach(btn => btn.classList.remove('active'));

        if (viewName === 'landing-page') {
            document.body.classList.add('landing-mode');
        } else {
            document.body.classList.remove('landing-mode');
            this.stopHeroSlider();
        }

        const backBtn = document.getElementById('btn-back-to-landing');
        if (backBtn) {
            backBtn.style.display = viewName === 'landing-page' ? 'none' : 'inline-flex';
        }

        const pageTitle = document.getElementById('page-title');
        const pageSubtitle = document.getElementById('page-subtitle');

        const navBtn = document.getElementById(`nav-btn-${viewName}`);
        if (navBtn) navBtn.classList.add('active');

        // Update topbar quick admin toggle button text
        const adminToggleText = document.getElementById('admin-toggle-text');
        if (adminToggleText) {
            if (viewName && viewName.startsWith('admin-')) {
                adminToggleText.innerText = 'Store';
            } else {
                adminToggleText.innerText = 'Admin Panel';
            }
        }

        this.updateCartBadges();
        if (typeof syncHeaderHeight === 'function') syncHeaderHeight();

        switch (viewName) {
            case 'landing-page':
                const landingView = document.getElementById('view-landing-page');
                if (landingView) landingView.style.display = 'block';
                if (pageTitle) pageTitle.innerText = "KMAP COMPUTERS";
                if (pageSubtitle) pageSubtitle.innerText = "Quality Laptops, Computers & Accessories | Sunyani";
                this.updateCartBadges();
                window.scrollTo({ top: 0, behavior: 'smooth' });
                this.renderHomepageFeaturedLaptops();
                this.updateFeaturedPrices();
                this.startHeroSlider();
                break;
            case 'client-store':
                document.getElementById('view-client-store').style.display = 'flex';
                pageTitle.innerText = "KMAP COMPUTERS";
                pageSubtitle.innerText = "Quality Laptops, Computers & Accessories | Sunyani";
                this.renderClientCatalog();
                break;
            case 'client-cart':
                document.getElementById('view-client-cart').style.display = 'block';
                pageTitle.innerText = "Shopping Cart";
                pageSubtitle.innerText = "Review your items and complete payment";
                this.renderCart();
                break;
            case 'client-favorites':
                document.getElementById('view-client-favorites').style.display = 'block';
                pageTitle.innerText = "Saved Favorites & Wishlist";
                pageSubtitle.innerText = "Machines you saved to buy later";
                this.renderFavorites();
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
            case 'admin-featured':
                document.getElementById('view-admin-featured').style.display = 'block';
                pageTitle.innerText = "Featured Laptops Manager";
                pageSubtitle.innerText = "Manage the 4 homepage showcase laptops (Strict 4-Slot Limit)";
                this.renderAdminFeatured();
                break;
            case 'admin-reports':
                document.getElementById('view-admin-reports').style.display = 'block';
                pageTitle.innerText = "Business Invoicing & Sales Reports";
                pageSubtitle.innerText = "Download printable reports and summaries";
                this.handleReportPresetChange();
                this.generateSalesReport();
                break;
            case 'admin-staff':
                document.getElementById('view-admin-staff').style.display = 'block';
                pageTitle.innerText = "Staff Management";
                pageSubtitle.innerText = "Manage employees, staff accounts, and administrator permissions";
                this.renderStaffList();
                break;
            case 'admin-backups':
                document.getElementById('view-admin-backups').style.display = 'block';
                pageTitle.innerText = "Database & Cloud Sync";
                pageSubtitle.innerText = "Localized system database operations and cloud replication";
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

    navigateToCategory(category) {
        this.switchView('client-store');
        this.activeCategory = category;
        const searchInput = document.getElementById('client-search');
        if (searchInput) searchInput.value = '';
        const catSelect = document.getElementById('client-category-select');
        if (catSelect) {
            catSelect.value = category;
        }
        this.renderClientCatalog();
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    landingSearch(e) {
        if (e) e.preventDefault();
        const input = document.getElementById('landing-search-input');
        const q = input ? input.value.trim() : '';
        this.switchView('client-store');
        const storeSearch = document.getElementById('client-search');
        if (storeSearch) {
            storeSearch.value = q;
        }
        this.renderClientCatalog();
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    scrollToSection(sectionId) {
        if (this.activeView !== 'landing-page') {
            this.switchView('landing-page');
        }
        setTimeout(() => {
            const el = document.getElementById(sectionId);
            if (el) {
                el.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
        }, 80);
    }

    openServicesModal() {
        const modal = document.getElementById('modal-services');
        if (modal) {
            modal.classList.add('active');
            this.updateScrollLock();
        }
    }

    closeServicesModal() {
        const modal = document.getElementById('modal-services');
        if (modal) {
            modal.classList.remove('active');
            this.updateScrollLock();
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
                <button class="nav-item" id="nav-btn-landing-page" onclick="app.switchView('landing-page')">
                    <i class="fa-solid fa-house"></i> Home
                </button>
                <button class="nav-item" id="nav-btn-client-store" onclick="app.switchView('client-store')">
                    <i class="fa-solid fa-store"></i> Store
                </button>
                <button class="nav-item" id="nav-btn-client-favorites" onclick="app.switchView('client-favorites')">
                    <i class="fa-solid fa-heart" style="color: #e53e3e;"></i> Saved Favorites (<span class="favorites-count">${this.favorites ? this.favorites.length : 0}</span>)
                </button>
                ${cartBtn}
                ${ordersBtn}
                <button class="nav-item" id="nav-btn-client-find-us" onclick="app.switchView('client-find-us')">
                    <i class="fa-solid fa-map-location-dot"></i> Find Us
                </button>
            `;
        } else {
            // Admin & Super Admin navbar: Full access to Store AND Staff Management
            nav.innerHTML = `
                <div style="font-size: 11px; font-weight: 700; color: var(--text-light); text-transform: uppercase; letter-spacing: 0.5px; padding: 6px 16px 4px;">Shop & Browse</div>
                <button class="nav-item" id="nav-btn-landing-page" onclick="app.switchView('landing-page')">
                    <i class="fa-solid fa-house"></i> Home
                </button>
                <button class="nav-item" id="nav-btn-client-store" onclick="app.switchView('client-store')">
                    <i class="fa-solid fa-store"></i> Store
                </button>
                <button class="nav-item" id="nav-btn-client-favorites" onclick="app.switchView('client-favorites')">
                    <i class="fa-solid fa-heart" style="color: #e53e3e;"></i> Saved Favorites (<span class="favorites-count">${this.favorites ? this.favorites.length : 0}</span>)
                </button>
                <div style="font-size: 11px; font-weight: 700; color: var(--text-light); text-transform: uppercase; letter-spacing: 0.5px; padding: 12px 16px 4px; cursor: pointer; display: flex; align-items: center; justify-content: space-between;" onclick="app.switchView('admin-staff')">
                    <span>Staff Management</span>
                    <i class="fa-solid fa-chevron-right" style="font-size: 9px; opacity: 0.5;"></i>
                </div>
                <button class="nav-item" id="nav-btn-admin-dashboard" onclick="app.switchView('admin-dashboard')">
                    <i class="fa-solid fa-chart-line"></i> Dashboard
                </button>
                <button class="nav-item" id="nav-btn-admin-inventory" onclick="app.switchView('admin-inventory')">
                    <i class="fa-solid fa-boxes-stacked"></i> Inventory & Stock
                </button>
                <button class="nav-item" id="nav-btn-admin-featured" onclick="app.switchView('admin-featured')">
                    <i class="fa-solid fa-star" style="color: #f59e0b;"></i> Featured Laptops (4)
                </button>
                <button class="nav-item" id="nav-btn-admin-orders" onclick="app.switchView('admin-orders')">
                    <i class="fa-solid fa-truck-fast"></i> Order Hub
                </button>
                <button class="nav-item" id="nav-btn-admin-staff" onclick="app.switchView('admin-staff')">
                    <i class="fa-solid fa-users-gear"></i> Staff Management
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
                    <i class="fa-solid fa-screwdriver-wrench"></i> Database & Cloud
                </button>
            `;
        }

        const logoutBtn = document.getElementById('sidebar-logout-btn');
        if (logoutBtn) {
            if (this.currentUser.role === 'guest') {
                logoutBtn.style.color = 'var(--accent)';
                logoutBtn.innerHTML = '<i class="fa-solid fa-user"></i> Sign In / Sign Up';
                logoutBtn.onclick = () => this.openLoginModal('signin');
            } else {
                logoutBtn.style.color = 'var(--error)';
                logoutBtn.innerHTML = '<i class="fa-solid fa-right-from-bracket"></i> Logout';
                logoutBtn.onclick = () => this.logout();
            }
        }
    }

    renderCategoryFilters() {
        const select = document.getElementById('client-category-select');
        if (!select) return;

        const products = this.db.getProducts();
        const standardCategories = ['Laptops', 'Accessories', 'Parts', 'Networking', 'Storage'];
        const categories = ['All', ...Array.from(new Set([...standardCategories, ...products.map(p => p.category).filter(Boolean)]))];

        const currentOptions = Array.from(select.options).map(o => o.value);
        const needsUpdate = categories.length !== currentOptions.length || !categories.every((c, i) => c === currentOptions[i]);

        if (needsUpdate || select.options.length === 0) {
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
            if (!this.activeCategory) {
                this.activeCategory = 'All';
            }
            this.categoryFiltersInitialized = true;
        }
        this.renderCategoryFilters();

        const query = document.getElementById('client-search').value.toLowerCase();
        const grid = document.getElementById('products-catalog-grid');
        grid.innerHTML = '';

        const products = this.db.getProducts();
        const filtered = products.filter(p => {
            const matchesQuery = p.name.toLowerCase().includes(query) || (p.category && p.category.toLowerCase().includes(query));
            const matchesCategory = this.activeCategory === 'All' || (p.category && p.category.toLowerCase() === this.activeCategory.toLowerCase());
            return matchesQuery && matchesCategory;
        });

        filtered.forEach(p => {
            const discPrice = this.getDiscountedPrice(p);
            const hasPromo = !p.priceDisplay && discPrice < p.price;
            let priceHtml = '';
            if (p.priceDisplay) {
                priceHtml = `<div class="product-price" style="font-weight: 800; color: #1e3a8a; letter-spacing: -0.2px;"><strong style="font-weight: 800;">${p.priceDisplay}</strong></div>`;
            } else if (hasPromo) {
                priceHtml = `<div class="product-price"><span class="original-price">GH₵ ${p.price.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span><span class="promo-price">GH₵ ${discPrice.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span></div>`;
            } else {
                priceHtml = `<div class="product-price">GH₵ ${p.price.toLocaleString(undefined, { minimumFractionDigits: 2 })}</div>`;
            }

            const promoBadge = hasPromo ? `<div class="promo-badge">PROMO</div>` : '';

            // Image handling (support up to 6 images, fallback to clean professional placeholder)
            const isLocalOrLaptop = p.category === 'Laptops' || (p.images && p.images[0] && p.images[0].startsWith('images/products/'));
            const fitStyle = isLocalOrLaptop ? 'object-fit:cover;' : 'object-fit:contain; background:#ffffff; padding:6px;';
            const noPhotoPlaceholder = `<div class="no-photo-placeholder" style="width:100%; height:100%; display:flex; flex-direction:column; align-items:center; justify-content:center; background:#f8fafc; color:#94a3b8; text-align:center; padding:16px; user-select:none;"><i class="fa-solid fa-camera" style="font-size:28px; margin-bottom:8px; opacity:0.6;"></i><span style="font-size:12px; font-weight:600; letter-spacing:0.3px; color:#64748b;">No Picture Available</span></div>`;
            const mainImg = (p.images && p.images.length > 0 && p.images[0])
                ? `<img src="${p.images[0]}" alt="${p.name}" loading="lazy" referrerpolicy="no-referrer" style="width:100%; height:100%; ${fitStyle} object-position:center; display:block;" onerror="this.style.display='none'; if(this.nextElementSibling) this.nextElementSibling.style.display='flex';"><div class="no-photo-placeholder" style="display:none; width:100%; height:100%; flex-direction:column; align-items:center; justify-content:center; background:#f8fafc; color:#94a3b8; text-align:center; padding:16px; user-select:none;"><i class="fa-solid fa-camera" style="font-size:28px; margin-bottom:8px; opacity:0.6;"></i><span style="font-size:12px; font-weight:600; letter-spacing:0.3px; color:#64748b;">No Picture Available</span></div>`
                : noPhotoPlaceholder;

            // Split specs by commas or newlines and show only the first two
            const specsArray = p.spec ? p.spec.split(/,|\n/).map(s => s.trim()).filter(s => s.length > 0) : [];
            const shortSpec = specsArray.length > 2
                ? `${specsArray[0]}, ${specsArray[1]}... <span style="color: var(--primary); font-weight: 700; text-decoration: underline;">See More</span>`
                : (p.spec || 'No specifications listed.');

            const card = document.createElement('div');
            card.className = 'card product-card';
            card.style.position = 'relative';
            card.style.cursor = 'pointer';
            card.onclick = (e) => {
                if (!e.target.closest('button')) {
                    this.openInspectModal(p.id);
                }
            };

            // Clicking card opens the product inspect view
            const isFav = this.isFavorite(p.id);
            card.innerHTML = `
                ${promoBadge}
                <button class="btn-fav-card ${isFav ? 'active' : ''}" data-id="${p.id}" onclick="event.stopPropagation(); app.toggleFavorite('${p.id}')" title="${isFav ? 'Remove from Favorites' : 'Save to Favorites'}" aria-label="Favorite">
                    <i class="${isFav ? 'fa-solid' : 'fa-regular'} fa-heart"></i>
                </button>
                <div style="display: flex; flex-direction: column; flex-grow: 1; justify-content: space-between; pointer-events: none;">
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

        const subtotalText = `GH₵ ${subtotal.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
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

        if (!Array.isArray(this.cart) || this.cart.length === 0) {
            this.showToast("Your cart is empty. Please add items to checkout.", 'error');
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

        // Hold order in provisional pending state — cart and stock remain 100% untouched until confirmed
        this.pendingCheckout = {
            id: uniqueId,
            clientName: this.currentUser.name,
            phone: userPhone,
            items: JSON.parse(JSON.stringify(this.cart)),
            total: subtotal,
            claimMethod: claimMethod,
            address: claimMethod === 'delivery' ? address : '',
            date: new Date().toISOString(),
            status: 'pending'
        };

        const callOverlay = document.getElementById('modal-checkout-call');
        if (callOverlay) {
            if (claimMethod === 'hire_purchase') {
                callOverlay.querySelector('.modal-content').innerHTML = `
                    <button onclick="app.cancelPendingCheckout(true)" style="position: absolute; top: 16px; right: 16px; background: none; border: none; font-size: 20px; cursor: pointer; color: var(--text-muted); padding: 4px; display: flex; align-items: center; justify-content: center;" aria-label="Close">
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
                        Please contact us via phone or WhatsApp to finalize your Hire Purchase agreement. Your cart items will remain saved until you call or message us.
                    </p>
                    
                    <div style="display: flex; flex-direction: column; gap: 12px;">
                        <div style="display: flex; gap: 12px;">
                            <button type="button" onclick="app.confirmAndFinalizeOrder('call')" class="btn btn-primary" style="height: 48px; color: #000000; font-weight: 700; display: flex; align-items: center; justify-content: center; gap: 8px; flex: 1; font-size: 13px; padding: 0 4px; cursor: pointer; border: none;">
                                <i class="fa-solid fa-phone"></i> Call to Complete
                            </button>
                            <button type="button" onclick="app.confirmAndFinalizeOrder('whatsapp')" class="btn btn-success" style="height: 48px; color: white; background-color: #25D366; border-color: #25D366; font-weight: 700; display: flex; align-items: center; justify-content: center; gap: 8px; flex: 1; font-size: 13px; padding: 0 4px; cursor: pointer; border: none;">
                                <i class="fa-brands fa-whatsapp"></i> WhatsApp Us
                            </button>
                        </div>
                        <button type="button" class="btn btn-outline" style="height: 42px; font-size: 13px; font-weight: 600;" onclick="app.cancelPendingCheckout(true)">
                            <i class="fa-solid fa-arrow-left"></i> Keep Items in Cart & Go Back
                        </button>
                    </div>
                `;
            } else {
                callOverlay.querySelector('.modal-content').innerHTML = `
                    <button onclick="app.cancelPendingCheckout(true)" style="position: absolute; top: 16px; right: 16px; background: none; border: none; font-size: 20px; cursor: pointer; color: var(--text-muted); padding: 4px; display: flex; align-items: center; justify-content: center;" aria-label="Close">
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
                        Click below to call or WhatsApp our line to make your payment and receive instant dispatch details. Your cart stays intact until you connect!
                    </p>
                    
                    <div style="display: flex; flex-direction: column; gap: 12px;">
                        <div style="display: flex; gap: 12px;">
                            <button type="button" onclick="app.confirmAndFinalizeOrder('call')" class="btn btn-primary" style="height: 48px; color: #000000; font-weight: 700; display: flex; align-items: center; justify-content: center; gap: 8px; flex: 1; font-size: 13px; padding: 0 4px; cursor: pointer; border: none;">
                                <i class="fa-solid fa-phone"></i> Call to Complete
                            </button>
                            <button type="button" onclick="app.confirmAndFinalizeOrder('whatsapp')" class="btn btn-success" style="height: 48px; color: white; background-color: #25D366; border-color: #25D366; font-weight: 700; display: flex; align-items: center; justify-content: center; gap: 8px; flex: 1; font-size: 13px; padding: 0 4px; cursor: pointer; border: none;">
                                <i class="fa-brands fa-whatsapp"></i> WhatsApp Us
                            </button>
                        </div>
                        <button type="button" class="btn btn-outline" style="height: 42px; font-size: 13px; font-weight: 600;" onclick="app.cancelPendingCheckout(true)">
                            <i class="fa-solid fa-arrow-left"></i> Keep Items in Cart & Go Back
                        </button>
                    </div>
                `;
            }
            callOverlay.classList.add('active');
            this.updateScrollLock();
        }
    }

    confirmAndFinalizeOrder(channel) {
        if (!this.pendingCheckout) {
            this.closeModal();
            return;
        }

        const order = this.pendingCheckout;
        this.pendingCheckout = null;

        // Deduct inventory stock
        const products = this.db.getProducts();
        order.items.forEach(cItem => {
            const p = products.find(prod => prod.id === cItem.id);
            if (p) p.stock = Math.max(0, (Number(p.stock) || 0) - (Number(cItem.qty) || 0));
        });

        // Save order firmly
        const orders = this.db.getOrders();
        orders.unshift(order);
        this.db.saveOrders(orders);
        this.db.saveProducts(products);
        this.db.addLog(`Placed pending order ${order.id} total: GH₵ ${order.total} via ${channel}`);

        // Securely push order to cloud KV database via dedicated safe action
        try {
            fetch(getSyncApiUrl(), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'create_order', order })
            }).catch(e => console.warn('Order cloud dispatch note:', e));
        } catch (e) { }

        // Firmly clear cart and update all badges across the entire interface
        this.cart = [];
        this.saveCart();
        this.renderCart();
        this.updateCartBadges();
        this.renderClientCatalog();

        // Close checkout modal
        const callOverlay = document.getElementById('modal-checkout-call');
        if (callOverlay) callOverlay.classList.remove('active');
        this.updateScrollLock();

        // Launch external call or WhatsApp connection
        const telNumber = '+233208341561';
        if (channel === 'call') {
            window.location.href = `tel:${telNumber}`;
        } else if (channel === 'whatsapp') {
            const claimLabel = (order.claimMethod || '').replace('_', ' ').toUpperCase();
            const itemsSummary = (order.items || []).map(i => `${i.name} (x${i.qty})`).join(', ');
            const msg = encodeURIComponent(
                `Hello Kmap Computers, I would like to complete my ${order.claimMethod === 'hire_purchase' ? 'Hire Purchase request' : 'order'} ${order.id} (${claimLabel}). Total: GH₵ ${order.total}.\nItems: ${itemsSummary}`
            );
            window.open(`https://wa.me/233208341561?text=${msg}`, '_blank');
        }

        this.showToast(`Order ${order.id} placed! Connecting to Kmap support...`);
        this.switchView('client-orders');
    }

    cancelPendingCheckout(showToast = true) {
        this.pendingCheckout = null;
        const callOverlay = document.getElementById('modal-checkout-call');
        if (callOverlay) callOverlay.classList.remove('active');
        this.updateScrollLock();
        this.renderCart();
        this.updateCartBadges();
        if (showToast) {
            this.showToast("Order not placed. All items are kept in your cart.");
        }
        this.switchView('client-cart');
    }

    cancelCheckout(orderId, showToast = true) {
        if (this.pendingCheckout && this.pendingCheckout.id === orderId) {
            this.cancelPendingCheckout(showToast);
            return;
        }

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

            this.saveCart();
            this.renderCart();
            this.updateCartBadges();
            this.renderClientCatalog();
            if (showToast) {
                this.showToast("Checkout cancelled. Items restored to your cart.");
            }
        }

        document.getElementById('modal-checkout-call').classList.remove('active');
        this.updateScrollLock();
        this.switchView('client-cart');
    }

    closeModal() {
        if (this.pendingCheckout) {
            this.cancelPendingCheckout(false);
            return;
        }
        const callOverlay = document.getElementById('modal-checkout-call');
        if (callOverlay) callOverlay.classList.remove('active');
        this.updateScrollLock();
    }

    // Promotions pricing utility
    getDiscountedPrice(p) {
        if (!p || typeof p.price !== 'number') return p?.price || 0;
        const promos = this.db.getPromos();
        let bestPrice = p.price;
        if (!Array.isArray(promos) || promos.length === 0) return bestPrice;

        const prodCat = (p.category || '').toLowerCase().trim();
        const prodCatNorm = prodCat.replace(/s$/, ''); // normalize "laptops" and "laptop"

        promos.forEach(promo => {
            if (promo.active === false || promo.status === 'inactive') return;

            let matches = false;
            const scope = (promo.scope || '').toLowerCase().trim();
            const promoCat = (promo.category || '').toLowerCase().trim();
            const promoCatNorm = promoCat.replace(/s$/, '');

            if (!scope || scope === 'all' || scope === 'store' || scope === 'storewide' || scope === 'all_products') {
                matches = true;
            } else if (scope === 'category') {
                if (!promoCat || promoCat === 'all' || promoCat === prodCat || promoCatNorm === prodCatNorm) {
                    matches = true;
                }
            } else if (scope === 'product') {
                if (promo.productId === p.id) {
                    matches = true;
                }
            } else if (scope === prodCat || scope === prodCatNorm) {
                matches = true;
            }

            if (matches) {
                const val = parseFloat(promo.value) || 0;
                let discounted = p.price;
                const type = (promo.type || '').toLowerCase().trim();
                if (type === 'percent' || type === 'percentage' || type === '%') {
                    discounted = p.price * (1 - val / 100);
                } else if (type === 'amount' || type === 'fixed') {
                    discounted = Math.max(0, p.price - val);
                } else if (val > 0 && val < 100) {
                    discounted = p.price * (1 - val / 100);
                }
                if (discounted < bestPrice) {
                    bestPrice = discounted;
                }
            }
        });
        return Math.round(bestPrice * 100) / 100;
    }

    handlePromoScopeChange() {
        const scope = document.getElementById('promo-scope').value;
        document.getElementById('promo-category-group').style.display = scope === 'category' ? 'block' : 'none';
        document.getElementById('promo-product-group').style.display = scope === 'product' ? 'block' : 'none';
    }

    renderPromotions() {
        const promoCatSelect = document.getElementById('promo-category');
        if (promoCatSelect) {
            const products = this.db.getProducts();
            const standardCategories = ['Laptops', 'Accessories', 'Parts', 'Networking', 'Storage'];
            const allCategories = Array.from(new Set([...standardCategories, ...products.map(p => p.category).filter(Boolean)]));
            const currentOptions = Array.from(promoCatSelect.options).map(o => o.value);
            const needsUpdate = allCategories.length !== currentOptions.length || !allCategories.every(c => currentOptions.includes(c));
            if (needsUpdate || promoCatSelect.options.length === 0) {
                const prevVal = promoCatSelect.value;
                promoCatSelect.innerHTML = '';
                allCategories.forEach(cat => {
                    const opt = document.createElement('option');
                    opt.value = cat;
                    opt.innerText = cat;
                    promoCatSelect.appendChild(opt);
                });
                if (prevVal) promoCatSelect.value = prevVal;
            }
        }

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
        this.updateFeaturedPrices();
    }

    deletePromotion(id) {
        let promos = this.db.getPromos();
        promos = promos.filter(p => p.id !== id);
        this.db.savePromos(promos);
        this.showToast("Promotion removed");
        this.renderPromotions();
        this.updateFeaturedPrices();
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

        document.title = (p.name || 'Product') + ' | Kmap Computers Sunyani';
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
        const hasPromo = !p.priceDisplay && discPrice < p.price;
        const originalPriceEl = document.getElementById('inspect-product-original-price');
        const priceEl = document.getElementById('inspect-product-price');

        if (p.priceDisplay) {
            originalPriceEl.style.display = 'none';
            priceEl.innerHTML = `<span style="font-weight: 800; color: #1e3a8a; letter-spacing: -0.3px;">${p.priceDisplay}</span>`;
        } else if (hasPromo) {
            originalPriceEl.style.display = 'inline';
            originalPriceEl.innerText = `GH₵ ${p.price.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
            priceEl.innerText = `GH₵ ${discPrice.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
        } else {
            originalPriceEl.style.display = 'none';
            priceEl.innerText = `GH₵ ${p.price.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
        }

        this.currentInspectProductId = productId;
        this.inspectImages = p.images || [];
        this.inspectImageIndex = 0;

        const mainImgDisplay = document.getElementById('inspect-img-display');
        const thumbContainer = document.getElementById('inspect-thumbnails-container');
        thumbContainer.innerHTML = '';

        if (this.inspectImages.length === 0) {
            mainImgDisplay.src = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 24 24" fill="none" stroke="%2394a3b8" stroke-width="2"><rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18"/><line x1="7" y1="2" x2="7" y2="22"/><line x1="17" y1="2" x2="17" y2="22"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="2" y1="7" x2="7" y2="7"/><line x1="2" y1="17" x2="7" y2="17"/><line x1="17" y1="17" x2="22" y2="17"/><line x1="17" y1="7" x2="22" y2="7"/></svg>';
            mainImgDisplay.style.opacity = '0.5';
            mainImgDisplay.onclick = null;
        } else {
            mainImgDisplay.src = this.inspectImages[0];
            mainImgDisplay.style.opacity = '1';
            mainImgDisplay.onclick = () => { this.openLightbox(mainImgDisplay.src, productId); };
            mainImgDisplay.onerror = () => {
                mainImgDisplay.src = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 24 24" fill="none" stroke="%2394a3b8" stroke-width="2"><rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18"/><line x1="7" y1="2" x2="7" y2="22"/><line x1="17" y1="2" x2="17" y2="22"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="2" y1="7" x2="7" y2="7"/><line x1="2" y1="17" x2="7" y2="17"/><line x1="17" y1="17" x2="22" y2="17"/><line x1="17" y1="7" x2="22" y2="7"/></svg>';
            };

            this.inspectImages.forEach((imgSrc, idx) => {
                const thumb = document.createElement('div');
                thumb.className = `inspect-thumb ${idx === 0 ? 'active' : ''}`;
                thumb.innerHTML = `<img src="${imgSrc}" onerror="this.style.opacity='0.3';">`;
                thumb.onclick = () => {
                    this.setInspectImage(idx);
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

        const favBtn = document.getElementById('inspect-fav-btn');
        if (favBtn) {
            const isFav = this.isFavorite(p.id);
            favBtn.innerHTML = `<i class="${isFav ? 'fa-solid' : 'fa-regular'} fa-heart"></i>`;
            favBtn.style.color = isFav ? '#e53e3e' : 'var(--text-light)';
            favBtn.title = isFav ? 'Remove from Favorites' : 'Save to Favorites';
            favBtn.onclick = () => {
                this.toggleFavorite(p.id);
                const updatedFav = this.isFavorite(p.id);
                favBtn.innerHTML = `<i class="${updatedFav ? 'fa-solid' : 'fa-regular'} fa-heart"></i>`;
                favBtn.style.color = updatedFav ? '#e53e3e' : 'var(--text-light)';
                favBtn.title = updatedFav ? 'Remove from Favorites' : 'Save to Favorites';
            };
        }

        document.getElementById('modal-product-inspect').classList.add('active');
        this.updateScrollLock();
    }

    setInspectImage(index) {
        if (!this.inspectImages || this.inspectImages.length === 0) return;
        this.inspectImageIndex = (index + this.inspectImages.length) % this.inspectImages.length;
        const mainImgDisplay = document.getElementById('inspect-img-display');
        if (mainImgDisplay) {
            mainImgDisplay.src = this.inspectImages[this.inspectImageIndex];
        }
        document.querySelectorAll('.inspect-thumb').forEach((t, i) => {
            t.classList.toggle('active', i === this.inspectImageIndex);
        });
    }

    closeInspectModal() {
        const modal = document.getElementById('modal-product-inspect');
        if (modal) modal.classList.remove('active');
        this.updateScrollLock();
        if (this.inspectBackView) {
            this.switchView(this.inspectBackView);
            this.inspectBackView = null;
        }
    }

    openLightbox(src, productId = null) {
        const modal = document.getElementById('lightbox-modal');
        const img = document.getElementById('lightbox-img');
        if (modal && img) {
            const targetProductId = productId || this.currentInspectProductId;
            this.lightboxImages = [];

            if (targetProductId) {
                const products = this.db.getProducts();
                const p = products.find(item => item.id === targetProductId);
                if (p && p.images && p.images.length > 0) {
                    this.lightboxImages = [...p.images];
                }
            }
            if (this.lightboxImages.length === 0 && this.inspectImages && this.inspectImages.length > 0) {
                this.lightboxImages = [...this.inspectImages];
            }

            // Do not open lightbox if there are no real photos (e.g. placeholder icon)
            if (this.lightboxImages.length === 0 && (!src || src.startsWith('data:image/svg'))) {
                return;
            }

            let foundIdx = -1;
            if (this.lightboxImages.length > 0 && src) {
                foundIdx = this.lightboxImages.findIndex(item => {
                    if (!item) return false;
                    return item === src || src.endsWith(item) || item.endsWith(src);
                });
            }

            this.lightboxIndex = foundIdx >= 0 ? foundIdx : (this.inspectImageIndex || 0);
            img.src = this.lightboxImages.length > 0 ? this.lightboxImages[this.lightboxIndex] : src;
            modal.classList.add('active');
            this.updateScrollLock();

            const prevBtn = document.querySelector('.lightbox-prev-btn');
            const nextBtn = document.querySelector('.lightbox-next-btn');
            if (prevBtn && nextBtn) {
                const showNav = this.lightboxImages.length > 1;
                prevBtn.style.display = showNav ? 'flex' : 'none';
                nextBtn.style.display = showNav ? 'flex' : 'none';
            }
        }
    }

    closeLightbox() {
        const modal = document.getElementById('lightbox-modal');
        if (modal) {
            modal.classList.remove('active');
            this.updateScrollLock();
        }
    }

    nextLightboxImage() {
        if (this.lightboxImages && this.lightboxImages.length > 1) {
            if (this.lightboxIndex < 0) this.lightboxIndex = 0;
            this.lightboxIndex = (this.lightboxIndex + 1) % this.lightboxImages.length;
            const img = document.getElementById('lightbox-img');
            if (img) img.src = this.lightboxImages[this.lightboxIndex];
        }
    }

    prevLightboxImage() {
        if (this.lightboxImages && this.lightboxImages.length > 1) {
            if (this.lightboxIndex < 0) this.lightboxIndex = 0;
            this.lightboxIndex = (this.lightboxIndex - 1 + this.lightboxImages.length) % this.lightboxImages.length;
            const img = document.getElementById('lightbox-img');
            if (img) img.src = this.lightboxImages[this.lightboxIndex];
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
            const willOpen = !sidebar.classList.contains('active');
            sidebar.classList.toggle('active', willOpen);
            backdrop.classList.toggle('active', willOpen);
            if (willOpen) {
                document.body.classList.add('sidebar-open');
            } else {
                document.body.classList.remove('sidebar-open');
            }
        }
    }

    closeSidebar() {
        const sidebar = document.querySelector('.sidebar');
        const backdrop = document.getElementById('sidebar-backdrop');
        if (sidebar) sidebar.classList.remove('active');
        if (backdrop) backdrop.classList.remove('active');
        document.body.classList.remove('sidebar-open');
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
            const dateStr = new Date(o.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
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
                <td><strong>GH₵ ${o.total.toLocaleString(undefined, { minimumFractionDigits: 2 })}</strong></td>
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

        document.getElementById('stat-revenue').innerText = `GH₵ ${revenue.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
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
                <td>GH₵ ${o.total.toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
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
        const searchInput = document.getElementById('admin-inventory-search');
        if (searchInput) searchInput.value = '';
        const catFilter = document.getElementById('admin-inventory-category-filter');
        if (catFilter) catFilter.value = 'all';
        const stockFilter = document.getElementById('admin-inventory-stock-filter');
        if (stockFilter) stockFilter.value = 'low_stock';
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
            const dStr = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
            dates.push(dStr);

            // Sum sales for that day
            const startDay = new Date(d.setHours(0, 0, 0, 0)).getTime();
            const endDay = new Date(d.setHours(23, 59, 59, 999)).getTime();

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
            tbody.innerHTML = `<tr><td colspan="9" style="text-align: center; color: var(--text-light)">No matching client orders found.</td></tr>`;
            return;
        }
        orders.forEach(o => {
            const tr = document.createElement('tr');
            const itemsStr = o.items.map(i => `${i.name} (x${i.qty})`).join(', ');
            const dateStr = new Date(o.date).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

            let selectStyle = 'border: 1px solid var(--border);';
            if (o.status === 'pending') selectStyle = 'background-color: rgba(244, 180, 0, 0.15); color: #B07D00; font-weight: 700; border-color: #F4B400;';
            if (o.status === 'confirmed') selectStyle = 'background-color: rgba(66, 133, 244, 0.15); color: #1A73E8; font-weight: 700; border-color: #4285F4;';
            if (o.status === 'in_transit') selectStyle = 'background-color: rgba(147, 51, 234, 0.15); color: #7E22CE; font-weight: 700; border-color: #9333EA;';
            if (o.status === 'completed') selectStyle = 'background-color: rgba(52, 168, 83, 0.15); color: #137333; font-weight: 700; border-color: #34A853;';
            if (o.status === 'void') selectStyle = 'background-color: rgba(217, 48, 37, 0.15); color: #C5221F; font-weight: 700; border-color: #D93025;';

            tr.innerHTML = `
                <td style="text-align: center;"><input type="checkbox" class="admin-order-select" value="${o.id}"></td>
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
                <td><strong>GH₵ ${o.total.toLocaleString(undefined, { minimumFractionDigits: 2 })}</strong></td>
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
            if (this.activeView === 'admin-dashboard') this.renderAdminOverview();
            if (this.activeView === 'admin-orders') this.renderAdminOrders();
            this.forceCloudSyncAll(false);
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
            const text = `${idx + 1}. ${item.name} (x${item.qty}) - GH₵ ${item.price.toLocaleString()} each`;
            doc.text(text, 14, y);
            y += 8;
        });

        doc.line(14, y + 4, 196, y + 4);
        doc.setFont("helvetica", "bold");
        doc.setFontSize(14);
        doc.text(`Total Amount: GH₵ ${o.total.toLocaleString(undefined, { minimumFractionDigits: 2 })}`, 14, y + 14);

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
            const text = `${idx + 1}. ID: ${o.id} | ${o.clientName} | ${dateStr} | ${o.status.toUpperCase()} | GH₵ ${o.total.toLocaleString()}`;
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
        if (!tbody) return;
        tbody.innerHTML = '';

        let products = this.db.getProducts();

        // Dynamically populate Category Filter with consistent categories
        const catFilter = document.getElementById('admin-inventory-category-filter');
        if (catFilter) {
            const currentSelected = catFilter.value || 'all';
            const standardCategories = ['Laptops', 'Accessories', 'Parts', 'Networking', 'Storage'];
            const allCategories = ['all', ...Array.from(new Set([...standardCategories, ...products.map(p => p.category).filter(Boolean)]))];
            const currentOptions = Array.from(catFilter.options).map(o => o.value);
            const needsUpdate = allCategories.length !== currentOptions.length || !allCategories.every((c, i) => c === currentOptions[i]);

            if (needsUpdate || catFilter.options.length <= 1) {
                catFilter.innerHTML = '<option value="all">All Categories</option>';
                allCategories.filter(c => c !== 'all').forEach(cat => {
                    const opt = document.createElement('option');
                    opt.value = cat;
                    opt.innerText = cat;
                    catFilter.appendChild(opt);
                });
                catFilter.value = allCategories.includes(currentSelected) ? currentSelected : 'all';
            }
        }

        const stockFilter = document.getElementById('admin-inventory-stock-filter');
        if (filterLowStock && stockFilter) {
            stockFilter.value = 'low_stock';
        }

        const selectedCategory = catFilter ? catFilter.value : 'all';
        const selectedStock = stockFilter ? stockFilter.value : (filterLowStock ? 'low_stock' : 'all');
        const searchInput = document.getElementById('admin-inventory-search');
        const query = searchInput ? searchInput.value.toLowerCase().trim() : '';

        // Filter by category
        if (selectedCategory && selectedCategory !== 'all') {
            products = products.filter(p => p.category && p.category.toLowerCase() === selectedCategory.toLowerCase());
        }

        // Filter by stock level
        if (selectedStock === 'low_stock') {
            products = products.filter(p => p.stock <= 3);
        } else if (selectedStock === 'in_stock') {
            products = products.filter(p => p.stock > 0);
        } else if (selectedStock === 'out_of_stock') {
            products = products.filter(p => p.stock === 0);
        }

        // Filter by search query
        if (query) {
            products = products.filter(p => {
                const name = (p.name || '').toLowerCase();
                const id = (p.id || '').toLowerCase();
                const category = (p.category || '').toLowerCase();
                const specs = (p.spec || p.specs || '').toLowerCase();
                const brand = (p.brand || '').toLowerCase();
                return name.includes(query) || id.includes(query) || category.includes(query) || specs.includes(query) || brand.includes(query);
            });
        }

        // Update count badge
        const countBadge = document.getElementById('admin-inventory-count');
        if (countBadge) {
            const totalProducts = this.db.getProducts().length;
            countBadge.innerText = `Showing ${products.length} of ${totalProducts} items`;
        }

        if (products.length === 0) {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td colspan="6" style="text-align: center; padding: 36px 16px; color: var(--text-light);">
                    <i class="fa-solid fa-boxes-stacked" style="font-size: 32px; margin-bottom: 10px; display: block; opacity: 0.35;"></i>
                    <strong style="display: block; margin-bottom: 4px;">No products found</strong>
                    <span style="font-size: 13px;">No items match your active search or filter criteria.</span>
                </td>
            `;
            tbody.appendChild(tr);
            return;
        }

        products.forEach(p => {
            const hasImg = p.images && p.images.length > 0 && p.images[0];
            const iconOrImg = hasImg
                ? `<img src="${p.images[0]}" alt="${p.name}" style="width:36px; height:36px; object-fit:cover; object-position:center; border-radius:4px; border:1px solid var(--border); background:#fff;" onerror="this.onerror=null; this.style.display='none'; if (this.nextElementSibling) this.nextElementSibling.style.display='inline-flex';"><div style="display:none; width:36px; height:36px; border-radius:4px; border:1px solid var(--border); background:#f1f5f9; align-items:center; justify-content:center; color:#94a3b8; font-size:13px;" title="No picture available"><i class="fa-solid fa-camera" style="opacity:0.7;"></i></div>`
                : `<div style="width:36px; height:36px; border-radius:4px; border:1px solid var(--border); background:#f1f5f9; display:inline-flex; align-items:center; justify-content:center; color:#94a3b8; font-size:13px;" title="No picture available"><i class="fa-solid fa-camera" style="opacity:0.7;"></i></div>`;

            let stockBadge = '';
            if (p.stock === 0) {
                stockBadge = `<span class="badge" style="background: rgba(217, 48, 37, 0.12); color: #C5221F; font-size: 11px; font-weight: 700; padding: 2px 6px; border-radius: 4px;">Out of Stock</span>`;
            } else if (p.stock <= 3) {
                stockBadge = `<span class="badge" style="background: rgba(244, 180, 0, 0.15); color: #B07D00; font-size: 11px; font-weight: 700; padding: 2px 6px; border-radius: 4px;">Low Stock</span>`;
            }

            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td><code>${p.id}</code></td>
                <td>
                    <div style="display:flex; align-items:center; gap:8px;">
                        ${iconOrImg}
                        <div>
                            <strong>${p.name}</strong>
                            ${p.brand ? `<div style="font-size: 11px; color: var(--text-light);">${p.brand}</div>` : ''}
                        </div>
                    </div>
                </td>
                <td><span style="display: inline-block; padding: 2px 8px; background: rgba(0,0,0,0.04); border-radius: 4px; font-size: 12px; font-weight: 500;">${p.category}</span></td>
                <td><strong>GH₵ ${Number(p.price || 0).toLocaleString()}</strong></td>
                <td>
                    <div style="display: flex; align-items: center; gap: 8px;">
                        <input type="number" class="form-control" style="width: 75px; padding: 4px 8px; font-weight: 600;" value="${p.stock}" min="0" onchange="app.updateProductStock('${p.id}', this.value)">
                        ${stockBadge}
                    </div>
                </td>
                <td>
                    <button class="btn btn-outline" style="padding: 4px 8px; font-size: 12px;" onclick="app.openProductModal('${p.id}')" title="Edit Product"><i class="fa-solid fa-pen"></i></button>
                    <button class="btn btn-danger" style="padding: 4px 8px; font-size: 12px;" onclick="app.deleteProduct('${p.id}')" title="Delete Product"><i class="fa-solid fa-trash"></i></button>
                </td>
            `;
            tbody.appendChild(tr);
        });
    }

    searchAdminInventory() {
        this.renderAdminInventory();
    }

    resetAdminInventoryFilters() {
        const searchInput = document.getElementById('admin-inventory-search');
        if (searchInput) searchInput.value = '';
        const catFilter = document.getElementById('admin-inventory-category-filter');
        if (catFilter) catFilter.value = 'all';
        const stockFilter = document.getElementById('admin-inventory-stock-filter');
        if (stockFilter) stockFilter.value = 'all';
        this.renderAdminInventory();
    }

    updateProductStock(prodId, newStock) {
        const products = this.db.getProducts();
        const p = products.find(item => item.id === prodId);
        if (p) {
            p.stock = Math.max(0, parseInt(newStock) || 0);
            this.db.saveProducts(products);
            this.forceCloudSyncAll(true);
            this.updateFeaturedPrices();
        }
    }

    // Helper: instantaneous, hardware-accelerated image compression (<25ms per photo) with fail-safe fallback
    async compressImageFile(file) {
        // Fast path 1: native hardware-accelerated browser bitmap decoding
        if (typeof window !== 'undefined' && 'createImageBitmap' in window) {
            try {
                const bmp = await createImageBitmap(file);
                const MAX_SIZE = 720;
                let targetWidth = bmp.width;
                let targetHeight = bmp.height;

                if (targetWidth > targetHeight) {
                    if (targetWidth > MAX_SIZE) {
                        targetHeight = Math.round(targetHeight * (MAX_SIZE / targetWidth));
                        targetWidth = MAX_SIZE;
                    }
                } else {
                    if (targetHeight > MAX_SIZE) {
                        targetWidth = Math.round(targetWidth * (MAX_SIZE / targetHeight));
                        targetHeight = MAX_SIZE;
                    }
                }

                const canvas = document.createElement('canvas');
                canvas.width = targetWidth;
                canvas.height = targetHeight;
                const ctx = canvas.getContext('2d', { alpha: false });
                ctx.fillStyle = '#ffffff';
                ctx.fillRect(0, 0, targetWidth, targetHeight);
                ctx.drawImage(bmp, 0, 0, targetWidth, targetHeight);
                bmp.close();

                const base64 = canvas.toDataURL('image/jpeg', 0.78);
                if (base64 && base64.length > 100) return base64;
            } catch (err) {
                // Fallback to Image element if format not handled by createImageBitmap
            }
        }

        // Fast path 2: direct Image object with object URL
        return new Promise((resolve) => {
            const objectUrl = URL.createObjectURL(file);
            const img = new Image();
            img.onerror = () => {
                URL.revokeObjectURL(objectUrl);
                // Fast path 3 fallback: raw FileReader (supports all browser image types)
                const reader = new FileReader();
                reader.onload = (e) => resolve(e.target.result);
                reader.onerror = () => resolve('');
                reader.readAsDataURL(file);
            };
            img.onload = () => {
                URL.revokeObjectURL(objectUrl);
                const MAX_SIZE = 720;
                let targetWidth = img.width;
                let targetHeight = img.height;

                if (targetWidth > targetHeight) {
                    if (targetWidth > MAX_SIZE) {
                        targetHeight = Math.round(targetHeight * (MAX_SIZE / targetWidth));
                        targetWidth = MAX_SIZE;
                    }
                } else {
                    if (targetHeight > MAX_SIZE) {
                        targetWidth = Math.round(targetWidth * (MAX_SIZE / targetHeight));
                        targetHeight = MAX_SIZE;
                    }
                }

                const canvas = document.createElement('canvas');
                canvas.width = targetWidth;
                canvas.height = targetHeight;
                const ctx = canvas.getContext('2d', { alpha: false });
                ctx.fillStyle = '#ffffff';
                ctx.fillRect(0, 0, targetWidth, targetHeight);
                ctx.drawImage(img, 0, 0, targetWidth, targetHeight);

                const base64 = canvas.toDataURL('image/jpeg', 0.78);
                resolve(base64);
            };
            img.src = objectUrl;
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
            thumb.style.cssText = 'position: relative; width: 68px; height: 68px; border-radius: 6px; overflow: hidden; border: 2px solid ' + (idx === 0 ? 'var(--secondary)' : 'var(--border)') + '; background: #fff; cursor: pointer;';
            thumb.title = idx === 0 ? 'Main Photo (shown on storefront card)' : 'Click to set as Main Photo';
            thumb.innerHTML = `
                <img src="${imgSrc}" style="width: 100%; height: 100%; object-fit: cover;">
                ${idx === 0 ? '<span style="position: absolute; bottom: 2px; left: 2px; font-size: 8px; font-weight: 800; background: var(--secondary); color: #000; padding: 1px 4px; border-radius: 3px; letter-spacing: 0.5px;">MAIN</span>' : ''}
                <button type="button" onclick="event.stopPropagation(); app.removeModalImage(${idx})" style="position: absolute; top: 2px; right: 2px; background: #dc2626; color: #fff; border: 1.5px solid #fff; border-radius: 50%; width: 22px; height: 22px; font-size: 11px; font-weight: 800; cursor: pointer; display: flex; align-items: center; justify-content: center; box-shadow: 0 1px 3px rgba(0,0,0,0.3); z-index: 10;" title="Remove this photo">✕</button>
            `;
            if (idx > 0) {
                thumb.onclick = () => app.setMainModalImage(idx);
            }
            container.appendChild(thumb);
        });
    }

    setMainModalImage(index) {
        const urlInputs = Array.from(document.querySelectorAll('.product-img-url'));
        const currentImages = urlInputs.map(input => input.value.trim()).filter(v => v.length > 0);
        if (index < currentImages.length) {
            const selected = currentImages.splice(index, 1)[0];
            currentImages.unshift(selected);
            urlInputs.forEach((input, idx) => {
                input.value = currentImages[idx] || '';
            });
            this.refreshModalImagePreviews();
        }
    }

    clearAllModalImages() {
        const urlInputs = Array.from(document.querySelectorAll('.product-img-url'));
        urlInputs.forEach(input => input.value = '');
        const fileInput = document.getElementById('form-product-file-upload');
        if (fileInput) fileInput.value = '';
        this.refreshModalImagePreviews();
    }

    removeModalImage(index) {
        const urlInputs = Array.from(document.querySelectorAll('.product-img-url'));
        const currentImages = urlInputs.map(input => input.value.trim()).filter(v => v.length > 0);
        currentImages.splice(index, 1);
        urlInputs.forEach((input, idx) => {
            input.value = currentImages[idx] || '';
        });
        const fileInput = document.getElementById('form-product-file-upload');
        if (fileInput) fileInput.value = '';
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

        // Dynamically ensure all consistent categories are populated in the select dropdown
        const catSelect = document.getElementById('form-product-category');
        if (catSelect) {
            const standardCategories = ['Laptops', 'Accessories', 'Parts', 'Networking', 'Storage'];
            const allCategories = Array.from(new Set([...standardCategories, ...this.db.getProducts().map(p => p.category).filter(Boolean)]));
            const currentOptions = Array.from(catSelect.options).map(o => o.value);
            const needsUpdate = allCategories.length !== currentOptions.length || !allCategories.every(c => currentOptions.includes(c));
            if (needsUpdate || catSelect.options.length === 0) {
                const prevVal = catSelect.value;
                catSelect.innerHTML = '';
                allCategories.forEach(cat => {
                    const opt = document.createElement('option');
                    opt.value = cat;
                    opt.innerText = cat;
                    catSelect.appendChild(opt);
                });
                if (prevVal) catSelect.value = prevVal;
            }
        }

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
        this.updateScrollLock();
    }

    closeProductModal() {
        document.getElementById('modal-product-form').classList.remove('active');
        this.updateScrollLock();
    }

    deleteProduct(id) {
        if (!confirm("Are you sure you want to delete this product?")) return;
        let products = this.db.getProducts();
        products = products.filter(p => p.id !== id);
        this.db.saveProducts(products);
        this.showToast("Product deleted from system inventory.");
        this.renderAdminInventory();
        this.forceCloudSyncAll(false);
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

        switch (preset) {
            case 'all_time':
                start = new Date(0);
                end = new Date();
                end.setHours(23, 59, 59, 999);
                break;
            case 'today':
                start.setHours(0, 0, 0, 0);
                end.setHours(23, 59, 59, 999);
                break;
            case 'yesterday':
                start.setDate(start.getDate() - 1);
                start.setHours(0, 0, 0, 0);
                end.setDate(end.getDate() - 1);
                end.setHours(23, 59, 59, 999);
                break;
            case 'this_week':
                const day = start.getDay();
                start.setDate(start.getDate() - day);
                start.setHours(0, 0, 0, 0);
                break;
            case 'this_month':
                start.setDate(1);
                start.setHours(0, 0, 0, 0);
                break;
            case 'this_year':
                start.setMonth(0, 1);
                start.setHours(0, 0, 0, 0);
                break;
            case 'custom':
                const customStart = document.getElementById('report-start-date').value;
                const customEnd = document.getElementById('report-end-date').value;
                if (!customStart || !customEnd) {
                    this.showToast("Select both start and end date.", 'error');
                    return;
                }
                start = new Date(customStart);
                start.setHours(0, 0, 0, 0);
                end = new Date(customEnd);
                end.setHours(23, 59, 59, 999);
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
                    phone: hp.phone || '',
                    items: `${hp.machine} (Initial Deposit)`,
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
                            phone: hp.phone || '',
                            items: `${hp.machine} (Installment ${inst.month}/${hp.months})`,
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
                phone: o.phone || '',
                items: (o.items || []).map(i => `${i.name} (x${i.quantity})`).join(', ') || 'Direct Purchase',
                type: (o.claimMethod || 'order').replace('_', ' ').toUpperCase(),
                total: o.total
            })),
            ...hpEvents
        ];
        allTransactions.sort((a, b) => new Date(b.date) - new Date(a.date));

        this.currentReportTransactions = allTransactions;
        this.currentReportPeriod = { start, end };

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
                <td style="text-align: right; font-weight:700;">GH₵ ${t.total.toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
            `;
            tbody.appendChild(tr);
        });

        document.getElementById('report-stat-revenue').innerText = `GH₵ ${totalRevenue.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
        document.getElementById('report-stat-count').innerText = allTransactions.length;
        document.getElementById('report-stat-average').innerText = `GH₵ ${(allTransactions.length > 0 ? totalRevenue / allTransactions.length : 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}`;

        const dateRangeStr = preset === 'all_time' ? 'All Time (Full History)' : `${start.toLocaleDateString()} - ${end.toLocaleDateString()}`;
        document.getElementById('report-subtitle').innerText = `Sales Analysis (${dateRangeStr})`;
    }

    toggleReportDownloadDropdown(e) {
        if (e) {
            e.preventDefault();
            e.stopPropagation();
        }
        const menu = document.getElementById('report-download-menu');
        const btn = document.getElementById('btn-download-report');
        if (!menu) return;
        const isOpen = menu.style.display === 'block';
        if (isOpen) {
            this.closeReportDownloadDropdown();
        } else {
            menu.style.display = 'block';
            if (btn) btn.setAttribute('aria-expanded', 'true');
        }
    }

    closeReportDownloadDropdown() {
        const menu = document.getElementById('report-download-menu');
        const btn = document.getElementById('btn-download-report');
        if (menu) menu.style.display = 'none';
        if (btn) btn.setAttribute('aria-expanded', 'false');
    }

    // Excel spreadsheet (.xlsx / .xls) generation
    downloadReportExcel() {
        this.closeReportDownloadDropdown();

        // Make sure current report transactions are populated
        if (!this.currentReportTransactions) {
            this.generateSalesReport();
        }

        const transactions = this.currentReportTransactions || [];
        const subtitle = document.getElementById('report-subtitle') ? document.getElementById('report-subtitle').innerText : 'Sales Analysis';
        const rev = document.getElementById('report-stat-revenue') ? document.getElementById('report-stat-revenue').innerText : 'GH₵ 0.00';
        const count = document.getElementById('report-stat-count') ? document.getElementById('report-stat-count').innerText : '0';
        const avg = document.getElementById('report-stat-average') ? document.getElementById('report-stat-average').innerText : 'GH₵ 0.00';

        const now = new Date();
        const dateTimestamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
        const userName = this.currentUser ? `${this.currentUser.name} (${this.currentUser.role.toUpperCase()})` : 'Authorized User';

        // Check if SheetJS (XLSX) is available
        if (typeof window.XLSX !== 'undefined' && window.XLSX.utils) {
            try {
                const wsData = [
                    ["KMAP COMPUTERS - SALES & FINANCIAL ASSESSMENT REPORT"],
                    ["Sunyani, Ghana | Contact: +23320 834 1561"],
                    [`Generated: ${now.toLocaleString()}`],
                    [`Period: ${subtitle}`],
                    [`Authorized By: ${userName}`],
                    [],
                    ["EXECUTIVE FINANCIAL SUMMARY"],
                    ["Metric", "Value"],
                    ["Total Sales Revenue", rev],
                    ["Total Completed Transactions", count],
                    ["Average Order Size", avg],
                    [],
                    ["TRANSACTION BREAKDOWN"],
                    ["Date", "Transaction ID", "Customer Name", "Contact Phone", "Items / Description", "Payment Type", "Status", "Amount (GH₵)"]
                ];

                let numericTotal = 0;
                transactions.forEach(t => {
                    numericTotal += (t.total || 0);
                    wsData.push([
                        new Date(t.date).toLocaleDateString(),
                        t.id,
                        t.clientName,
                        t.phone || 'N/A',
                        t.items || t.type,
                        t.type,
                        "COMPLETED",
                        t.total
                    ]);
                });

                if (transactions.length > 0) {
                    wsData.push([]);
                    wsData.push(["TOTAL REVENUE", "", "", "", "", "", "", numericTotal]);
                } else {
                    wsData.push(["No completed transactions recorded for this period."]);
                }

                const ws = window.XLSX.utils.aoa_to_sheet(wsData);

                // Column formatting widths
                ws['!cols'] = [
                    { wch: 14 }, // Date
                    { wch: 18 }, // ID
                    { wch: 24 }, // Customer Name
                    { wch: 16 }, // Phone
                    { wch: 42 }, // Items / Description
                    { wch: 18 }, // Payment Type
                    { wch: 14 }, // Status
                    { wch: 16 }  // Amount
                ];

                const wb = window.XLSX.utils.book_new();
                window.XLSX.utils.book_append_sheet(wb, ws, "Sales Summary");

                const filename = `KMAP_Sales_Report_${dateTimestamp}.xlsx`;
                const wbout = window.XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
                const blob = new Blob([wbout], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });

                if (window.navigator && window.navigator.msSaveOrOpenBlob) {
                    window.navigator.msSaveOrOpenBlob(blob, filename);
                } else {
                    const url = URL.createObjectURL(blob);
                    const link = document.createElement('a');
                    link.style.display = 'none';
                    link.href = url;
                    link.setAttribute('download', filename);
                    document.body.appendChild(link);
                    link.click();
                    setTimeout(() => {
                        try {
                            document.body.removeChild(link);
                            URL.revokeObjectURL(url);
                        } catch (e) { }
                    }, 1500);
                }

                this.db.addLog(`Downloaded Sales Report as Excel (${filename})`);
                this.showToast(`📥 Excel file "${filename}" downloaded to your Downloads!`, 'success');
                return;
            } catch (err) {
                console.error("SheetJS XLSX generation error, using native Excel XML fallback:", err);
            }
        }

        // Native Excel XML Spreadsheet 2003 (.xls) Fallback
        // This is a genuine Excel spreadsheet recognized natively by Microsoft Excel on Windows with green Excel icon!
        try {
            const filename = `KMAP_Sales_Report_${dateTimestamp}.xls`;
            const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

            let xml = '<?xml version="1.0"?>\n';
            xml += '<?mso-application progid="Excel.Sheet"?>\n';
            xml += '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"\n';
            xml += ' xmlns:o="urn:schemas-microsoft-com:office:office"\n';
            xml += ' xmlns:x="urn:schemas-microsoft-com:office:excel"\n';
            xml += ' xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"\n';
            xml += ' xmlns:html="http://www.w3.org/TR/REC-html40">\n';
            xml += '<Styles>\n';
            xml += ' <Style ss:ID="Header"><Font ss:Bold="1" ss:Size="14" ss:Color="#DA9100"/></Style>\n';
            xml += ' <Style ss:ID="SubHeader"><Font ss:Bold="1" ss:Color="#555555"/></Style>\n';
            xml += ' <Style ss:ID="ColHeader"><Font ss:Bold="1" ss:Color="#FFFFFF"/><Interior ss:Color="#DA9100" ss:Pattern="Solid"/></Style>\n';
            xml += ' <Style ss:ID="TotalRow"><Font ss:Bold="1"/><Interior ss:Color="#FEF2D5" ss:Pattern="Solid"/></Style>\n';
            xml += '</Styles>\n';
            xml += '<Worksheet ss:Name="Sales Summary">\n';
            xml += '<Table>\n';
            xml += '<Column ss:Width="90"/>\n<Column ss:Width="110"/>\n<Column ss:Width="140"/>\n<Column ss:Width="100"/>\n<Column ss:Width="220"/>\n<Column ss:Width="120"/>\n<Column ss:Width="90"/>\n<Column ss:Width="100"/>\n';

            xml += `<Row><Cell ss:StyleID="Header"><Data ss:Type="String">KMAP COMPUTERS - SALES &amp; FINANCIAL ASSESSMENT REPORT</Data></Cell></Row>\n`;
            xml += `<Row><Cell ss:StyleID="SubHeader"><Data ss:Type="String">Sunyani, Ghana | Contact: +23320 834 1561</Data></Cell></Row>\n`;
            xml += `<Row><Cell><Data ss:Type="String">Generated: ${esc(now.toLocaleString())}</Data></Cell></Row>\n`;
            xml += `<Row><Cell><Data ss:Type="String">Period: ${esc(subtitle)}</Data></Cell></Row>\n`;
            xml += `<Row><Cell><Data ss:Type="String">Authorized By: ${esc(userName)}</Data></Cell></Row>\n`;
            xml += '<Row/>\n';

            xml += '<Row><Cell ss:StyleID="SubHeader"><Data ss:Type="String">EXECUTIVE FINANCIAL SUMMARY</Data></Cell></Row>\n';
            xml += `<Row><Cell><Data ss:Type="String">Total Sales Revenue</Data></Cell><Cell><Data ss:Type="String">${esc(rev)}</Data></Cell></Row>\n`;
            xml += `<Row><Cell><Data ss:Type="String">Total Completed Transactions</Data></Cell><Cell><Data ss:Type="String">${esc(count)}</Data></Cell></Row>\n`;
            xml += `<Row><Cell><Data ss:Type="String">Average Order Size</Data></Cell><Cell><Data ss:Type="String">${esc(avg)}</Data></Cell></Row>\n`;
            xml += '<Row/>\n';

            xml += '<Row><Cell ss:StyleID="SubHeader"><Data ss:Type="String">TRANSACTION BREAKDOWN</Data></Cell></Row>\n';
            xml += '<Row ss:StyleID="ColHeader">';
            ['Date', 'Transaction ID', 'Customer Name', 'Contact Phone', 'Items / Description', 'Payment Type', 'Status', 'Amount (GH₵)'].forEach(h => {
                xml += `<Cell><Data ss:Type="String">${esc(h)}</Data></Cell>`;
            });
            xml += '</Row>\n';

            let numericTotal = 0;
            transactions.forEach(t => {
                numericTotal += (t.total || 0);
                const dateStr = new Date(t.date).toLocaleDateString();
                xml += '<Row>';
                xml += `<Cell><Data ss:Type="String">${esc(dateStr)}</Data></Cell>`;
                xml += `<Cell><Data ss:Type="String">${esc(t.id)}</Data></Cell>`;
                xml += `<Cell><Data ss:Type="String">${esc(t.clientName)}</Data></Cell>`;
                xml += `<Cell><Data ss:Type="String">${esc(t.phone || 'N/A')}</Data></Cell>`;
                xml += `<Cell><Data ss:Type="String">${esc(t.items || t.type)}</Data></Cell>`;
                xml += `<Cell><Data ss:Type="String">${esc(t.type)}</Data></Cell>`;
                xml += `<Cell><Data ss:Type="String">COMPLETED</Data></Cell>`;
                xml += `<Cell><Data ss:Type="Number">${t.total}</Data></Cell>`;
                xml += '</Row>\n';
            });

            if (transactions.length > 0) {
                xml += '<Row ss:StyleID="TotalRow">';
                xml += '<Cell><Data ss:Type="String">TOTAL REVENUE</Data></Cell><Cell/><Cell/><Cell/><Cell/><Cell/><Cell/>';
                xml += `<Cell><Data ss:Type="Number">${numericTotal}</Data></Cell>`;
                xml += '</Row>\n';
            } else {
                xml += '<Row><Cell><Data ss:Type="String">No completed transactions recorded for this period.</Data></Cell></Row>\n';
            }

            xml += '</Table>\n</Worksheet>\n</Workbook>';

            const blob = new Blob([xml], { type: 'application/vnd.ms-excel;charset=utf-8;' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.style.display = 'none';
            link.href = url;
            link.setAttribute('download', filename);
            document.body.appendChild(link);
            link.click();
            setTimeout(() => {
                try {
                    document.body.removeChild(link);
                    URL.revokeObjectURL(url);
                } catch (e) { }
            }, 1500);

            this.db.addLog(`Downloaded Sales Report as Excel (${filename})`);
            this.showToast(`📥 Excel file "${filename}" downloaded to your Downloads!`, 'success');
        } catch (e) {
            console.error("Failed to export Excel report:", e);
            this.showToast("Failed to generate Excel report file.", 'error');
        }
    }

    // PDF generation using jsPDF library
    downloadReportPDF() {
        this.closeReportDownloadDropdown();

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
        this.showToast(`Report downloaded successfully as PDF!`);
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
        const dataUri = 'data:application/json;charset=utf-8,' + encodeURIComponent(str);

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

    // Staff Management Directory listing (available to all admins)
    renderStaffList() {
        const tbody = document.getElementById('staff-list-tbody');
        if (!tbody) return;
        tbody.innerHTML = '';

        // Exclude clients, guests, and Alfred from the visible accounts interface
        const users = this.db.getUsers().filter(u => 
            u.role !== 'client' && 
            u.role !== 'guest' && 
            u.username !== 'alfred' && 
            (u.email || '').toLowerCase() !== 'alfred@kmapcomputers.com' && 
            !u.hiddenFromStaffList
        );

        users.forEach(u => {
            const tr = document.createElement('tr');
            const isSuper = u.role === 'superadmin' || u.username === 'admin';
            const badgeClass = u.role === 'superadmin' ? 'badge-primary' : 'badge-success';
            tr.innerHTML = `
                <td>
                    <strong>${u.name || u.username}</strong><br>
                    <span style="font-size: 12px; color: var(--primary); font-family: monospace;">${u.email || '@' + u.username}</span>
                </td>
                <td><span class="badge ${badgeClass}">${u.role.toUpperCase()}</span></td>
                <td>
                    <div style="display: flex; gap: 6px; align-items: center;">
                        <button class="btn btn-outline" style="padding: 4px 8px; font-size: 11px;" 
                            onclick="app.promptChangePassword('${u.username}')" title="Change Password">
                            <i class="fa-solid fa-key"></i> Password
                        </button>
                        <button class="btn btn-danger" style="padding: 4px 8px; font-size: 11px;" 
                            onclick="app.deleteStaff('${u.username}')" ${isSuper ? 'disabled title="Superadmin account cannot be removed"' : ''}>
                            <i class="fa-solid fa-trash"></i>
                        </button>
                    </div>
                </td>
            `;
            tbody.appendChild(tr);
        });
    }

    promptChangePassword(username) {
        this.openChangePasswordModalForUser(username);
    }

    deleteStaff(username) {
        if (username === 'alfred' || username === 'admin' || username === 'alfred@kmapcomputers.com' || username === 'admin@kmapcomputers.com') {
            this.showToast("Root superadmin accounts cannot be removed.", 'error');
            return;
        }
        if (!confirm(`Are you sure you want to remove staff account: ${username}?`)) return;
        let users = this.db.getUsers();
        users = users.filter(u => u.username !== username && u.email !== username);
        this.db.saveUsers(users);
        this.db.addLog(`Removed staff user: ${username}`);
        this.showToast(`User ${username} removed.`);
        this.renderStaffList();
        this.forceCloudSyncAll(false);
    }

    // Real-time toast alerts (monochromatic, clean, completely no-color)
    showToast(msg, type = 'info') {
        const container = document.getElementById('toast-container');
        if (!container) return;

        // Dismiss older toasts if 2 or more are already active
        while (container.children.length >= 2) {
            container.removeChild(container.firstChild);
        }

        const toast = document.createElement('div');
        toast.className = 'toast';
        toast.style.background = '#111827';
        toast.style.color = '#ffffff';
        toast.style.border = '1px solid rgba(255, 255, 255, 0.15)';

        toast.innerHTML = `
            <i class="fa-solid fa-circle-info" style="color: #ffffff; font-size: 14px; flex-shrink: 0; opacity: 0.9;"></i>
            <span style="line-height: 1.4; color: #ffffff;">${msg}</span>
        `;
        container.appendChild(toast);

        const duration = type === 'error' ? 4500 : 2500;
        setTimeout(() => {
            toast.style.transition = 'opacity 0.2s ease, transform 0.2s ease';
            toast.style.opacity = '0';
            toast.style.transform = 'translateY(10px)';
            setTimeout(() => toast.remove(), 200);
        }, duration);
    }

    // Real-time order notification engine
    checkOrderNotifications(newOrders) {
        if (!Array.isArray(newOrders)) return;

        const isAdmin = this.currentUser && ['admin', 'superadmin'].includes(this.currentUser.role);
        const isClient = this.currentUser && this.currentUser.role === 'client';
        const clientIdentifier = isClient ? (this.currentUser.phone || this.currentUser.username || '') : '';

        // 1. Detect new orders & status updates
        newOrders.forEach(no => {
            // Admin notification on newly placed customer order
            if (isAdmin && !this.knownOrdersMap.has(no.id)) {
                this.showToast(`New Order Received: ${no.id} - GH₵ ${Number(no.total || 0).toLocaleString()} from ${no.clientName || 'Customer'}`);
            }

            // Customer notification when admin updates their order status
            if (isClient && no.phone === clientIdentifier && this.knownOrdersMap.has(no.id)) {
                const prevStatus = this.knownOrdersMap.get(no.id);
                if (prevStatus && prevStatus !== no.status) {
                    const statusText = (no.status || '').replace(/_/g, ' ').toUpperCase();
                    this.showToast(`Order ${no.id} status updated to: ${statusText}`);
                }
            }
        });

        // 2. Detect cancellations / deleted orders
        this.knownOrdersMap.forEach((prevStatus, orderId) => {
            if (!newOrders.some(no => no.id === orderId)) {
                if (isAdmin) {
                    this.showToast(`Order ${orderId} was cancelled or removed.`);
                }
            }
        });

        // Update known orders map
        this.knownOrdersMap.clear();
        newOrders.forEach(o => this.knownOrdersMap.set(o.id, o.status));
    }

    // ==========================================
    // HIRE PURCHASE SYSTEM METHODS
    // ==========================================

    // Open create HP modal
    openHPModal() {
        document.getElementById('modal-hp-form').classList.add('active');
        this.updateScrollLock();

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

        // Reset custom input & group
        const customGroup = document.getElementById('form-hp-custom-product-group');
        if (customGroup) customGroup.style.display = 'none';
        document.getElementById('form-hp-product-custom').style.display = 'none';
        document.getElementById('form-hp-product-custom').required = false;

        // Trigger default product change to auto-fill price
        this.handleHPProductChange();
    }

    closeHPModal() {
        document.getElementById('modal-hp-form').classList.remove('active');
        this.updateScrollLock();
        document.getElementById('hp-details-form').reset();
    }

    handleHPProductChange() {
        const select = document.getElementById('form-hp-product-select');
        const customGroup = document.getElementById('form-hp-custom-product-group');
        const customInput = document.getElementById('form-hp-product-custom');
        const priceInput = document.getElementById('form-hp-price');

        if (select.value === 'custom') {
            if (customGroup) customGroup.style.display = 'block';
            customInput.style.display = 'block';
            customInput.required = true;
            customInput.value = '';
            priceInput.value = '';
        } else {
            if (customGroup) customGroup.style.display = 'none';
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
        document.getElementById('hp-stat-balance').innerText = `GH₵ ${outstandingBalance.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
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
                <td>GH₵ ${hp.price.toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                <td>GH₵ ${hp.deposit.toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                <td style="font-weight: 600;">GH₵ ${unpaidBalance.toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
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
        this.updateScrollLock();

        // Render top summary in details view
        const unpaid = hp.price - hp.deposit - hp.installments.filter(inst => inst.status === 'paid').reduce((sum, inst) => sum + inst.amount, 0);
        document.getElementById('hp-details-info').innerHTML = `
            <div><strong>Client:</strong> ${hp.clientName} (${hp.phone})</div>
            <div><strong>Item:</strong> ${hp.machine}</div>
            <div><strong>Total Price:</strong> GH₵ ${hp.price.toLocaleString(undefined, { minimumFractionDigits: 2 })}</div>
            <div><strong>Deposit:</strong> GH₵ ${hp.deposit.toLocaleString(undefined, { minimumFractionDigits: 2 })}</div>
            <div><strong>Outstanding:</strong> GH₵ ${unpaid.toLocaleString(undefined, { minimumFractionDigits: 2 })}</div>
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
                <td>GH₵ ${inst.amount.toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
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
        this.updateScrollLock();
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

    handleAccountAction() {
        if (this.currentUser && this.currentUser.role !== 'guest') {
            this.openUserProfileModal();
        } else {
            this.openLoginModal('signin');
        }
    }

    openUserProfileModal() {
        if (!this.currentUser || this.currentUser.role === 'guest') {
            this.openLoginModal('signin');
            return;
        }

        const nameEl = document.getElementById('profile-modal-name');
        const userEl = document.getElementById('profile-modal-username');
        const avatarEl = document.getElementById('profile-modal-avatar');
        const emailEl = document.getElementById('profile-modal-email');
        const roleEl = document.getElementById('profile-modal-role');
        const adminBtn = document.getElementById('profile-modal-admin-btn');

        if (nameEl) nameEl.innerText = this.currentUser.name || this.currentUser.username;
        if (userEl) userEl.innerText = this.currentUser.username;
        if (avatarEl) avatarEl.innerText = (this.currentUser.name || this.currentUser.username || 'U').charAt(0).toUpperCase();
        if (emailEl) {
            if (this.currentUser.email && this.currentUser.email.trim()) {
                emailEl.innerText = this.currentUser.email.trim();
                emailEl.style.display = 'block';
            } else {
                emailEl.innerText = '';
                emailEl.style.display = 'none';
            }
        }
        if (roleEl) {
            const roleLabels = { superadmin: 'Super Admin', admin: 'Staff / Admin', user: 'Customer', client: 'Customer' };
            roleEl.innerText = roleLabels[this.currentUser.role] || this.currentUser.role;
        }
        if (adminBtn) {
            const isStaff = ['admin', 'superadmin'].includes(this.currentUser.role);
            adminBtn.style.display = isStaff ? 'flex' : 'none';
        }

        document.getElementById('modal-user-profile').classList.add('active');
        this.updateScrollLock();
    }

    closeUserProfileModal() {
        document.getElementById('modal-user-profile').classList.remove('active');
        this.updateScrollLock();
    }

    openChangePasswordFromProfile() {
        this.closeUserProfileModal();
        this.openChangePasswordModal();
    }

    async hashPassword(plainPassword) {
        if (!plainPassword) return '';
        // If already a 64-character hex string, it is already hashed with SHA-256
        if (/^[a-f0-9]{64}$/i.test(plainPassword)) return plainPassword.toLowerCase();
        try {
            const encoder = new TextEncoder();
            const data = encoder.encode('kmap_salt_2026_' + plainPassword);
            const hashBuffer = await window.crypto.subtle.digest('SHA-256', data);
            const hashArray = Array.from(new Uint8Array(hashBuffer));
            return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
        } catch (e) {
            let hash = 0;
            for (let i = 0; i < plainPassword.length; i++) {
                hash = ((hash << 5) - hash) + plainPassword.charCodeAt(i);
                hash |= 0;
            }
            return 'kmap_fallback_' + Math.abs(hash).toString(16);
        }
    }

    openChangePasswordModal() {
        if (this.currentUser.role === 'guest') {
            this.showToast("Guest account cannot change password. Sign in to continue.", 'error');
            return;
        }
        this.openChangePasswordModalForUser(this.currentUser.username);
    }

    openChangePasswordModalForUser(username) {
        const users = this.db.getUsers();
        const user = users.find(u => u.username === username || (u.email && u.email.toLowerCase() === username.toLowerCase()));
        if (!user) {
            this.showToast("User not found.", 'error');
            return;
        }

        this.otpTargetUser = user;
        const targetEmail = user.email || `${user.username}@kmapcomputers.com`;
        this.targetOtpEmail = targetEmail;

        const emailDisplay = document.getElementById('pw-target-email');
        if (emailDisplay) emailDisplay.innerText = `${user.name || user.username} (${targetEmail})`;

        const picker = document.getElementById('pw-target-email-picker');
        if (picker) picker.style.display = 'none';

        this.resetOtpModalState();
        document.getElementById('modal-change-password').classList.add('active');
        this.updateScrollLock();
    }

    openOtpResetModal() {
        this.closeLoginModal();

        // Default to first admin email
        this.targetOtpEmail = 'admin@kmapcomputers.com';
        const emailDisplay = document.getElementById('pw-target-email');
        if (emailDisplay) emailDisplay.innerText = 'Select your staff account below:';

        const picker = document.getElementById('pw-target-email-picker');
        if (picker) {
            picker.style.display = 'block';
            const select = document.getElementById('pw-reset-email-select');
            if (select) this.targetOtpEmail = select.value;
        }

        const users = this.db.getUsers();
        this.otpTargetUser = users.find(u => u.email && u.email.toLowerCase() === this.targetOtpEmail.toLowerCase()) || null;

        this.resetOtpModalState();
        document.getElementById('modal-change-password').classList.add('active');
        this.updateScrollLock();
    }

    onResetEmailSelectChange(selectedEmail) {
        this.targetOtpEmail = selectedEmail;
        const users = this.db.getUsers();
        this.otpTargetUser = users.find(u => u.email && u.email.toLowerCase() === selectedEmail.toLowerCase()) || null;
        this.resetOtpModalState();
    }

    resetOtpModalState() {
        if (this.otpTimerInterval) {
            clearInterval(this.otpTimerInterval);
            this.otpTimerInterval = null;
        }
        this.activeOtp = null;

        const timerBadge = document.getElementById('pw-otp-timer-badge');
        if (timerBadge) {
            timerBadge.style.display = 'none';
            timerBadge.innerText = '⏱️ 05:00';
            timerBadge.className = 'badge badge-success';
        }

        const btn = document.getElementById('btn-request-pw-otp');
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = '<i class="fa-solid fa-paper-plane"></i> Send 6-Digit OTP to Email';
        }

        const statusMsg = document.getElementById('pw-otp-status-msg');
        if (statusMsg) {
            statusMsg.innerHTML = 'Click above to dispatch a strict 5-minute one-time code to your Hostinger mailbox.';
        }

        const changePwForm = document.getElementById('change-password-form');
        if (changePwForm) changePwForm.reset();
    }

    async requestPasswordOtp() {
        const email = this.targetOtpEmail || (this.otpTargetUser ? this.otpTargetUser.email : (this.currentUser ? this.currentUser.email : ''));
        if (!email) {
            this.showToast("No authorized email address specified for verification.", 'error');
            return;
        }

        const btn = document.getElementById('btn-request-pw-otp');
        const statusMsg = document.getElementById('pw-otp-status-msg');

        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Contacting mail server...';
        }
        if (statusMsg) statusMsg.innerText = `Dispatching secure OTP to ${email}...`;

        try {
            const res = await fetch(getOtpApiUrl(), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'send', email })
            });
            const data = await res.json().catch(() => ({}));

            if (res.ok && data.success) {
                this.activeOtpRequested = true;
                this.startOtpTimer(data.expiresInSeconds || 300);

                if (data.emailSent) {
                    this.showToast(`Verification code sent to ${email}! Check your Hostinger inbox.`, 'success');
                    if (statusMsg) statusMsg.innerHTML = `<span style="color: var(--secondary); font-weight: 700;">✅ Code delivered to ${email}.</span> Check your inbox or webmail.`;
                } else {
                    this.showToast(`Verification code generated for ${email}. (5-min strict timer active)`);
                    if (statusMsg) {
                        statusMsg.innerHTML = `<span>Code active for <strong>${email}</strong>. Expires in 5 minutes. Check inbox.</span>`;
                    }
                }
            } else {
                this.showToast(data.error || "Failed to dispatch OTP.", 'error');
                if (btn) {
                    btn.disabled = false;
                    btn.innerHTML = '<i class="fa-solid fa-paper-plane"></i> Send 6-Digit OTP to Email';
                }
            }
        } catch (err) {
            this.showToast("Failed to dispatch OTP: " + err.message, 'error');
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = '<i class="fa-solid fa-paper-plane"></i> Send 6-Digit OTP to Email';
            }
        }
    }

    startOtpTimer(durationSeconds) {
        if (this.otpTimerInterval) clearInterval(this.otpTimerInterval);
        const timerBadge = document.getElementById('pw-otp-timer-badge');
        const btn = document.getElementById('btn-request-pw-otp');
        if (timerBadge) {
            timerBadge.style.display = 'inline-block';
            timerBadge.className = 'badge badge-success';
        }

        let remaining = durationSeconds;
        const updateDisplay = () => {
            const mins = Math.floor(remaining / 60);
            const secs = remaining % 60;
            const str = `⏱️ ${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
            if (timerBadge) timerBadge.innerText = str;

            if (remaining <= 0) {
                clearInterval(this.otpTimerInterval);
                this.otpTimerInterval = null;
                if (timerBadge) {
                    timerBadge.innerText = '⏱️ Expired';
                    timerBadge.className = 'badge';
                    timerBadge.style.background = 'rgba(217, 48, 37, 0.1)';
                    timerBadge.style.color = 'var(--error)';
                }
                if (btn) {
                    btn.disabled = false;
                    btn.innerHTML = '<i class="fa-solid fa-rotate-right"></i> Resend New OTP';
                }
                if (this.activeOtp) {
                    this.activeOtp.code = null; // Invalidate immediately
                }
                this.showToast("Security OTP has expired. Please request a new code.", 'error');
            }
            remaining--;
        };

        updateDisplay();
        this.otpTimerInterval = setInterval(updateDisplay, 1000);
    }

    async verifyAndOverridePassword(otpInput, newPw, confirmPw) {
        if (newPw !== confirmPw) {
            this.showToast("New passwords do not match. Please re-type.", 'error');
            return;
        }

        if (newPw.length < 6) {
            this.showToast("Password must be at least 6 characters long.", 'error');
            return;
        }

        const email = (this.targetOtpEmail || (this.otpTargetUser ? this.otpTargetUser.email : (this.currentUser ? this.currentUser.email : ''))).toLowerCase();

        const submitBtn = document.getElementById('btn-confirm-pw-change');
        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Verifying with Server...';
        }

        try {
            const res = await fetch(getOtpApiUrl(), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'verify', email, otp: otpInput, newPassword: newPw })
            });
            const data = await res.json().catch(() => ({}));

            if (res.ok && data.success) {
                if (data.token) safeLocalStorage.setItem('kmap_auth_token', data.token);
                if (data.user) {
                    safeLocalStorage.setItem('kmap_current_user', JSON.stringify(data.user));
                    this.currentUser = data.user;
                    this.updateProfileHeader(data.user);
                }

                if (this.otpTimerInterval) clearInterval(this.otpTimerInterval);
                this.activeOtpRequested = false;

                this.showToast(data.message || "Password updated successfully!", 'success');
                this.closeChangePasswordModal();
            } else {
                this.showToast(data.error || "Incorrect or expired verification code.", 'error');
            }
        } catch (netErr) {
            this.showToast("Connection failed during verification.", 'error');
        } finally {
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.innerHTML = 'Confirm & Override Password';
            }
        }
    }

    closeChangePasswordModal() {
        document.getElementById('modal-change-password').classList.remove('active');
        this.updateScrollLock();
        this.resetOtpModalState();
    }

    goBack() {
        if (window.history && window.history.back) {
            window.history.back();
        }
    }

    goForward() {
        if (window.history && window.history.forward) {
            window.history.forward();
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
        this.currentUser = { username: 'guest', role: 'guest', name: 'Guest Viewer' };
        if (!preserveCart) this.cart = [];
        safeLocalStorage.removeItem('kmap_current_user');
        safeLocalStorage.removeItem('kmap_auth_token');

        this.closeLoginModal();
        this.updateProfileHeader(this.currentUser);
        this.renderSidebar();
        this.loadCart();
        this.syncDownstream();
        this.switchView('client-store');
    }

    closeActiveModal(overlay) {
        if (!overlay) return;
        const id = overlay.id;
        if (id === 'modal-login') this.closeLoginModal();
        else if (id === 'modal-product-inspect') this.closeInspectModal();
        else if (id === 'lightbox-modal') this.closeLightbox();
        else if (id === 'modal-checkout-call') this.closeModal();
        else if (id === 'modal-product-form') this.closeProductModal();
        else if (id === 'modal-hp-form') this.closeHPModal();
        else if (id === 'modal-hp-details') this.closeHPDetailsModal();
        else if (id === 'modal-user-profile') this.closeUserProfileModal();
        else if (id === 'modal-change-password') this.closeChangePasswordModal();
        else {
            overlay.classList.remove('active');
            this.updateScrollLock();
        }
    }

    // Hero Floater Slider Controls
    _applyHeroSlide(index) {
        // Internal: just change the visible slide, no interval side-effects
        const slides = document.querySelectorAll('.hero-floater-slide');
        const dots   = document.querySelectorAll('#hero-slider-dots .hero-dot');
        if (!slides.length) return;
        this.currentHeroSlide = (index + slides.length) % slides.length;
        slides.forEach((s, i) => s.classList.toggle('active', i === this.currentHeroSlide));
        dots.forEach((d, i)   => d.classList.toggle('active', i === this.currentHeroSlide));
    }

    setHeroSlide(index) {
        // Called from dot clicks — change slide AND reset the auto-timer
        this._applyHeroSlide(index);
        this.stopHeroSlider();
        this.startHeroSlider();
    }

    startHeroSlider() {
        if (this.heroSliderInterval) return; // already running
        this.heroSliderInterval = setInterval(() => {
            const slides = document.querySelectorAll('.hero-floater-slide');
            if (!slides.length) return;
            const next = ((this.currentHeroSlide || 0) + 1) % slides.length;
            this._applyHeroSlide(next);  // no interval restart inside auto-advance
        }, 4500);
    }

    stopHeroSlider() {
        if (this.heroSliderInterval) {
            clearInterval(this.heroSliderInterval);
            this.heroSliderInterval = null;
        }
    }

    restartHeroSlider() {
        this.stopHeroSlider();
        this.startHeroSlider();
    }

    // Update current prices on Featured Laptops & Hero showcase after every promo is applied
    updateFeaturedPrices() {
        const products = this.db.getProducts();

        // 1. Update Featured Laptop Cards
        document.querySelectorAll('.featured-laptop-card').forEach(card => {
            let prodId = card.getAttribute('data-product-id');
            if (!prodId) {
                const match = card.innerHTML.match(/openInspectModal\(['"]([^'"]+)['"]\)/) || card.innerHTML.match(/addToCart\(['"]([^'"]+)['"]\)/);
                if (match) prodId = match[1];
            }
            if (!prodId) return;
            const p = products.find(item => item.id === prodId);
            if (!p) return;

            const discPrice = this.getDiscountedPrice(p);
            const hasPromo = discPrice < p.price;
            const priceEl = card.querySelector('.feat-card-price');
            if (priceEl) {
                if (hasPromo) {
                    priceEl.innerHTML = `<span class="original-price" style="text-decoration: line-through; color: #94a3b8; font-size: 13px; font-weight: 600; margin-right: 6px;">GH₵ ${p.price.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}</span><span class="promo-price" style="color: #dc2626; font-weight: 900;">GH₵ ${discPrice.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}</span>`;
                } else {
                    priceEl.innerHTML = `GH₵ ${p.price.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
                }
            }

            // Promo Badge Tag
            const tagsContainer = card.querySelector('.feat-card-tags');
            let promoBadge = card.querySelector('.feat-promo-tag');
            if (hasPromo) {
                const percentOff = Math.round(((p.price - discPrice) / p.price) * 100);
                const discountText = percentOff > 0 ? `${percentOff}% OFF PROMO` : 'PROMO DEAL';
                if (!promoBadge && tagsContainer) {
                    promoBadge = document.createElement('span');
                    promoBadge.className = 'feat-tag feat-promo-tag';
                    promoBadge.style.cssText = 'background: #fef2f2; color: #dc2626; border: 1px solid #fecaca; font-weight: 700;';
                    tagsContainer.prepend(promoBadge);
                }
                if (promoBadge) {
                    promoBadge.innerText = discountText;
                }
            } else if (promoBadge) {
                promoBadge.remove();
            }

            // Stock status update
            const stockEl = card.querySelector('.feat-card-stock');
            if (stockEl) {
                if (p.stock === 0) {
                    stockEl.innerHTML = `<span class="stock-dot" style="background:#dc2626;"></span> <span style="color:#dc2626; font-weight:700;">Out of Stock</span>`;
                } else if (p.stock <= 3) {
                    stockEl.innerHTML = `<span class="stock-dot" style="background:#eab308;"></span> <span style="color:#d97706; font-weight:700;">Low Stock (${p.stock} left)</span>`;
                } else {
                    stockEl.innerHTML = `<span class="stock-dot"></span> In Stock`;
                }
            }
        });

        // 2. Update Hero Laptop Floater Slides
        document.querySelectorAll('.hero-floater-slide').forEach(slide => {
            let prodId = slide.getAttribute('data-product-id');
            if (!prodId) {
                const match = slide.innerHTML.match(/openInspectModal\(['"]([^'"]+)['"]\)/) || slide.innerHTML.match(/addToCart\(['"]([^'"]+)['"]\)/);
                if (match) prodId = match[1];
            }
            if (!prodId) return;
            const p = products.find(item => item.id === prodId);
            if (!p) return;

            const discPrice = this.getDiscountedPrice(p);
            const hasPromo = discPrice < p.price;
            const priceEl = slide.querySelector('.slide-badge-price');
            if (priceEl) {
                if (hasPromo) {
                    priceEl.innerHTML = `<span style="text-decoration: line-through; opacity: 0.7; font-size: 11px; margin-right: 5px;">GH₵ ${p.price.toLocaleString()}</span><span style="color: #fef08a; font-weight: 900;">GH₵ ${discPrice.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}</span>`;
                } else {
                    priceEl.innerHTML = `GH₵ ${p.price.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
                }
            }
        });
    }

    // Render Homepage Featured Laptops (Grid and Hero Floater)
    renderHomepageFeaturedLaptops() {
        const grid = document.getElementById('homepage-featured-grid');
        const showcase = document.getElementById('hero-laptop-showcase');
        const featuredItems = (this.db.getFeaturedLaptops() || []).slice(0, 4);
        const products = this.db.getProducts();

        const brandPills = {
            'hp': 'brand-hp-pill',
            'dell': 'brand-dell-pill',
            'lenovo': 'brand-lenovo-pill',
            'apple': 'brand-apple-pill',
            'acer': 'brand-acer-pill',
            'asus': 'brand-asus-pill',
            'toshiba': 'brand-toshiba-pill'
        };

        // 1. Render Homepage Grid Cards (Strict 4 items)
        if (grid && featuredItems.length > 0) {
            grid.innerHTML = '';
            featuredItems.forEach((item, idx) => {
                const p = item.productId ? products.find(prod => prod.id === item.productId) : null;
                const price = p ? p.price : (Number(item.price) || 0);
                const discPrice = p ? this.getDiscountedPrice(p) : this.getDiscountedPrice({ price, category: 'Laptops' });
                const hasPromo = discPrice < price;
                const brandKey = (item.brand || (p ? p.brand : '') || 'hp').toLowerCase();
                const badgeClass = brandPills[brandKey] || 'brand-hp-pill';
                const imgUrl = item.image || (p && p.images && p.images[0] ? p.images[0] : 'images/default-laptop.jpg');
                const title = item.title || (p ? p.name : `Featured Laptop ${idx + 1}`);
                const specs = item.specs || (p ? (p.spec || p.desc || '') : '');
                const stock = p ? p.stock : 10;
                const prodId = p ? p.id : (item.productId || `FEAT-${idx + 1}`);

                let stockHtml = `<span class="stock-dot"></span> In Stock`;
                if (stock === 0) {
                    stockHtml = `<span class="stock-dot" style="background:#dc2626;"></span> <span style="color:#dc2626; font-weight:700;">Out of Stock</span>`;
                } else if (stock <= 3) {
                    stockHtml = `<span class="stock-dot" style="background:#eab308;"></span> <span style="color:#d97706; font-weight:700;">Low Stock (${stock} left)</span>`;
                }

                const percentOff = Math.round(((price - discPrice) / price) * 100);
                const promoTagHtml = hasPromo
                    ? `<span class="feat-tag feat-promo-tag" style="background: #fef2f2; color: #dc2626; border: 1px solid #fecaca; font-weight: 700;">${percentOff > 0 ? `${percentOff}% OFF PROMO` : 'PROMO DEAL'}</span>`
                    : '';

                const priceHtml = hasPromo
                    ? `<span class="original-price" style="text-decoration: line-through; color: #94a3b8; font-size: 13px; font-weight: 600; margin-right: 6px;">GH₵ ${price.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}</span><span class="promo-price" style="color: #dc2626; font-weight: 900;">GH₵ ${discPrice.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}</span>`
                    : `GH₵ ${price.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

                const card = document.createElement('div');
                card.className = 'featured-laptop-card';
                card.setAttribute('data-product-id', prodId);
                card.innerHTML = `
                    <div class="feat-card-badge ${badgeClass}">${item.brand || 'LAPTOP'}</div>
                    <div class="feat-card-thumb" onclick="app.openInspectModal('${prodId}')">
                        <img src="${imgUrl}" alt="${title}" onerror="this.onerror=null; this.src='images/default-laptop.jpg';">
                    </div>
                    <h3 class="feat-card-title" onclick="app.openInspectModal('${prodId}')">${title}</h3>
                    <p class="feat-card-specs">${specs.replace(/\n/g, '<br>')}</p>
                    <div class="feat-card-price">${priceHtml}</div>
                    <div class="feat-card-stock">${stockHtml}</div>
                    <div class="feat-card-tags">
                        ${promoTagHtml}
                        <span class="feat-tag">Quality Laptop</span>
                        <span class="feat-tag">3 Months Warranty</span>
                    </div>
                    <button type="button" class="feat-add-cart-btn" onclick="app.addToCart('${prodId}')">
                        <i class="fa-solid fa-cart-shopping"></i> Add to Cart
                    </button>
                `;
                grid.appendChild(card);
            });
        }

        // 2. Render Hero Slider Slides (Matching the 4 featured laptops)
        if (showcase && featuredItems.length > 0) {
            showcase.innerHTML = '';
            featuredItems.forEach((item, idx) => {
                const p = item.productId ? products.find(prod => prod.id === item.productId) : null;
                const price = p ? p.price : (Number(item.price) || 0);
                const discPrice = p ? this.getDiscountedPrice(p) : this.getDiscountedPrice({ price, category: 'Laptops' });
                const hasPromo = discPrice < price;
                const imgUrl = item.image || (p && p.images && p.images[0] ? p.images[0] : 'images/default-laptop.jpg');
                const title = item.title || (p ? p.name : `Featured Laptop ${idx + 1}`);
                const prodId = p ? p.id : (item.productId || `FEAT-${idx + 1}`);
                const heroLabel = item.heroLabel || (p ? `${(p.brand || 'KMAP').toUpperCase()} FLAGSHIP` : 'KMAP SHOWCASE');

                const priceHtml = hasPromo
                    ? `<span style="text-decoration: line-through; opacity: 0.7; font-size: 11px; margin-right: 5px;">GH₵ ${price.toLocaleString()}</span><span style="color: #fef08a; font-weight: 900;">GH₵ ${discPrice.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}</span>`
                    : `GH₵ ${price.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

                const slide = document.createElement('div');
                slide.className = `hero-floater-slide ${idx === (this.currentHeroSlide || 0) ? 'active' : ''}`;
                slide.setAttribute('data-slide', idx);
                slide.setAttribute('data-product-id', prodId);
                slide.onclick = () => this.openInspectModal(prodId);
                slide.innerHTML = `
                    <div class="hero-slide-badge">
                        <span class="slide-badge-brand">${heroLabel}</span>
                        <span class="slide-badge-title">${title}</span>
                        <span class="slide-badge-price">${priceHtml}</span>
                    </div>
                    <img src="${imgUrl}" alt="${title}" class="hero-laptop-img" onerror="this.onerror=null; this.src='images/default-laptop.jpg';">
                `;
                showcase.appendChild(slide);
            });

            // Update dots
            const dotsContainer = document.getElementById('hero-slider-dots');
            if (dotsContainer) {
                dotsContainer.innerHTML = '';
                featuredItems.forEach((item, idx) => {
                    const dot = document.createElement('span');
                    dot.className = `hero-dot ${idx === (this.currentHeroSlide || 0) ? 'active' : ''}`;
                    dot.title = item.title || `Slide ${idx + 1}`;
                    dot.onclick = () => this.setHeroSlide(idx);
                    dotsContainer.appendChild(dot);
                });
            }
        }
    }

    // Render Admin Featured Laptops Manager (Strict 4 Slots)
    renderAdminFeatured() {
        const container = document.getElementById('admin-featured-slots-container');
        if (!container) return;

        let featuredItems = (this.db.getFeaturedLaptops() || []).slice(0, 4);
        while (featuredItems.length < 4) {
            featuredItems.push({
                slot: featuredItems.length + 1,
                productId: '',
                brand: 'HP',
                title: `Featured Laptop ${featuredItems.length + 1}`,
                specs: 'Core i7 | 16GB RAM\n512GB SSD | FHD',
                heroLabel: 'KMAP SHOWCASE',
                price: 5000,
                image: 'images/default-laptop.jpg'
            });
        }

        const products = this.db.getProducts();
        const laptopProducts = products.filter(p => !p.category || p.category.toLowerCase().includes('laptop') || p.category === 'Laptops');
        const candidateList = laptopProducts.length > 0 ? laptopProducts : products;

        const optionsHtml = candidateList.map(p => {
            return `<option value="${p.id}">[${p.id}] ${p.name} - GH₵ ${p.price.toLocaleString()}</option>`;
        }).join('');

        container.innerHTML = '';

        featuredItems.forEach((item, idx) => {
            const slot = idx + 1;
            const brand = (item.brand || 'HP').toUpperCase();
            const card = document.createElement('div');
            card.className = 'card';
            card.style.cssText = 'border: 2px solid var(--border-color); border-radius: var(--radius); padding: 18px; display: flex; flex-direction: column; justify-content: space-between; box-shadow: 0 4px 12px rgba(0,0,0,0.03);';

            card.innerHTML = `
                <div>
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px; padding-bottom: 10px; border-bottom: 1px solid var(--border-color);">
                        <div style="display: flex; align-items: center; gap: 8px;">
                            <span class="badge" style="background: var(--primary); color: #fff; font-size: 13px; font-weight: 800; padding: 4px 10px; border-radius: 6px;">
                                SLOT ${slot}
                            </span>
                            <strong style="font-size: 15px; color: var(--text-color);">${slot === 1 ? 'Hero Lead Laptop' : `Featured Laptop #${slot}`}</strong>
                        </div>
                        <span style="font-size: 11px; background: rgba(245, 158, 11, 0.1); color: #d97706; font-weight: 700; padding: 3px 8px; border-radius: 12px;">Slot ${slot} of 4</span>
                    </div>

                    <div class="form-group" style="margin-bottom: 14px; background: rgba(0,0,0,0.02); padding: 10px; border-radius: var(--radius-sm); border: 1px dashed var(--border-color);">
                        <label style="font-size: 12px; font-weight: 700; color: var(--secondary); margin-bottom: 4px; display: block;">
                            <i class="fa-solid fa-bolt"></i> Quick Pick from Stock Inventory:
                        </label>
                        <select id="feat-slot-${slot}-prod-id" class="form-control" style="font-size: 13px;" onchange="app.selectFeaturedFromInventory(${slot}, this.value)">
                            <option value="">-- Choose In-Stock Laptop to Auto-Fill --</option>
                            ${optionsHtml}
                        </select>
                    </div>

                    <div style="display: grid; grid-template-columns: 2fr 1fr; gap: 10px; margin-bottom: 10px;">
                        <div class="form-group" style="margin-bottom: 0;">
                            <label style="font-size: 12px; font-weight: 600;">Laptop Model Title *</label>
                            <input type="text" id="feat-slot-${slot}-title" class="form-control" value="${item.title || ''}" placeholder="e.g. Hp Zbook 15u G6">
                        </div>
                        <div class="form-group" style="margin-bottom: 0;">
                            <label style="font-size: 12px; font-weight: 600;">Brand Pill</label>
                            <select id="feat-slot-${slot}-brand" class="form-control">
                                <option value="HP" ${brand === 'HP' ? 'selected' : ''}>HP</option>
                                <option value="DELL" ${brand === 'DELL' ? 'selected' : ''}>DELL</option>
                                <option value="Lenovo" ${brand === 'LENOVO' ? 'selected' : ''}>Lenovo</option>
                                <option value="Apple" ${brand === 'APPLE' ? 'selected' : ''}>Apple</option>
                                <option value="Asus" ${brand === 'ASUS' ? 'selected' : ''}>Asus</option>
                                <option value="Acer" ${brand === 'ACER' ? 'selected' : ''}>Acer</option>
                                <option value="Toshiba" ${brand === 'TOSHIBA' ? 'selected' : ''}>Toshiba</option>
                            </select>
                        </div>
                    </div>

                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 10px;">
                        <div class="form-group" style="margin-bottom: 0;">
                            <label style="font-size: 12px; font-weight: 600;">Regular Price (GH₵) *</label>
                            <input type="number" id="feat-slot-${slot}-price" class="form-control" value="${item.price || 0}" min="0">
                        </div>
                        <div class="form-group" style="margin-bottom: 0;">
                            <label style="font-size: 12px; font-weight: 600;">Hero Label Badge</label>
                            <input type="text" id="feat-slot-${slot}-hero" class="form-control" value="${item.heroLabel || ''}" placeholder="e.g. HP WORKSTATION">
                        </div>
                    </div>

                    <div class="form-group" style="margin-bottom: 12px;">
                        <label style="font-size: 12px; font-weight: 600;">Specifications (Use | or new lines)</label>
                        <textarea id="feat-slot-${slot}-specs" class="form-control" rows="2" style="font-size: 12px; resize: vertical;" placeholder="Core i7 | 32GB RAM&#10;1TB SSD | 15.6 FHD">${(item.specs || '').replace(/<br>/g, '\n')}</textarea>
                    </div>

                    <div class="form-group" style="margin-bottom: 12px;">
                        <label style="font-size: 12px; font-weight: 600; display: block; margin-bottom: 4px;">Laptop Photo (Upload file or paste URL)</label>
                        <div style="display: flex; gap: 12px; align-items: center;">
                            <div style="width: 70px; height: 70px; border-radius: 8px; border: 1px solid var(--border-color); overflow: hidden; background: #f8fafc; display: flex; align-items: center; justify-content: center; flex-shrink: 0;">
                                <img id="feat-slot-${slot}-preview" src="${item.image || 'images/default-laptop.jpg'}" alt="Preview" style="max-width: 100%; max-height: 100%; object-fit: contain;">
                            </div>
                            <div style="flex: 1; display: flex; flex-direction: column; gap: 6px;">
                                <input type="file" id="feat-slot-${slot}-file" accept="image/*" class="form-control" style="font-size: 12px; padding: 4px;" onchange="app.handleFeaturedSlotFileUpload(${slot}, this)">
                                <input type="text" id="feat-slot-${slot}-image" class="form-control" style="font-size: 11px;" value="${item.image || ''}" placeholder="Or image path / URL" oninput="document.getElementById('feat-slot-${slot}-preview').src = this.value">
                            </div>
                        </div>
                    </div>
                </div>

                <div style="display: flex; justify-content: space-between; align-items: center; padding-top: 12px; border-top: 1px solid var(--border-color); margin-top: 6px;">
                    <button class="btn btn-outline" style="font-size: 12px; padding: 6px 12px;" onclick="app.clearFeaturedSlot(${slot})">
                        <i class="fa-solid fa-rotate-left"></i> Revert
                    </button>
                    <button class="btn btn-secondary" style="font-size: 13px; padding: 6px 14px; font-weight: 700;" onclick="app.saveSingleFeaturedSlot(${slot})">
                        <i class="fa-solid fa-check"></i> Save Slot ${slot}
                    </button>
                </div>
            `;

            container.appendChild(card);

            if (item.productId) {
                const select = document.getElementById(`feat-slot-${slot}-prod-id`);
                if (select) select.value = item.productId;
            }
        });
    }

    // Auto-fill slot from inventory selection
    selectFeaturedFromInventory(slot, prodId) {
        if (!prodId) return;
        const products = this.db.getProducts();
        const p = products.find(prod => prod.id === prodId);
        if (!p) return;

        const titleInput = document.getElementById(`feat-slot-${slot}-title`);
        const priceInput = document.getElementById(`feat-slot-${slot}-price`);
        const specsInput = document.getElementById(`feat-slot-${slot}-specs`);
        const brandSelect = document.getElementById(`feat-slot-${slot}-brand`);
        const heroInput = document.getElementById(`feat-slot-${slot}-hero`);
        const imgInput = document.getElementById(`feat-slot-${slot}-image`);
        const previewImg = document.getElementById(`feat-slot-${slot}-preview`);

        if (titleInput) titleInput.value = p.name;
        if (priceInput) priceInput.value = p.price;
        if (specsInput) specsInput.value = p.spec || p.desc || '';
        if (brandSelect && p.brand) {
            const bUpper = p.brand.toUpperCase();
            Array.from(brandSelect.options).forEach(opt => {
                if (opt.value.toUpperCase() === bUpper) brandSelect.value = opt.value;
            });
        }
        if (heroInput) heroInput.value = `${(p.brand || 'KMAP').toUpperCase()} FLAGSHIP`;
        if (p.images && p.images[0]) {
            if (imgInput) imgInput.value = p.images[0];
            if (previewImg) previewImg.src = p.images[0];
        }
    }

    // Handle image file upload with compression to keep storage light and fast
    handleFeaturedSlotFileUpload(slot, input) {
        if (!input.files || !input.files[0]) return;
        const file = input.files[0];
        const reader = new FileReader();
        reader.onload = (e) => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                let width = img.width;
                let height = img.height;
                const maxDim = 800;
                if (width > maxDim || height > maxDim) {
                    if (width > height) {
                        height = Math.round((height * maxDim) / width);
                        width = maxDim;
                    } else {
                        width = Math.round((width * maxDim) / height);
                        height = maxDim;
                    }
                }
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, width, height);
                const dataUrl = canvas.toDataURL('image/jpeg', 0.85);

                const imgInput = document.getElementById(`feat-slot-${slot}-image`);
                const previewImg = document.getElementById(`feat-slot-${slot}-preview`);
                if (imgInput) imgInput.value = dataUrl;
                if (previewImg) previewImg.src = dataUrl;
            };
            img.src = e.target.result;
        };
        reader.readAsDataURL(file);
    }

    // Collect data object for a single slot from form
    collectFeaturedSlotData(slot) {
        const prodSelect = document.getElementById(`feat-slot-${slot}-prod-id`);
        const titleInput = document.getElementById(`feat-slot-${slot}-title`);
        const brandSelect = document.getElementById(`feat-slot-${slot}-brand`);
        const priceInput = document.getElementById(`feat-slot-${slot}-price`);
        const heroInput = document.getElementById(`feat-slot-${slot}-hero`);
        const specsInput = document.getElementById(`feat-slot-${slot}-specs`);
        const imgInput = document.getElementById(`feat-slot-${slot}-image`);

        return {
            slot: slot,
            productId: prodSelect ? prodSelect.value : '',
            title: titleInput ? titleInput.value.trim() : `Featured Laptop ${slot}`,
            brand: brandSelect ? brandSelect.value : 'HP',
            price: priceInput ? Number(priceInput.value) || 0 : 0,
            heroLabel: heroInput ? heroInput.value.trim() : 'KMAP SHOWCASE',
            specs: specsInput ? specsInput.value.trim() : '',
            image: imgInput ? imgInput.value.trim() : 'images/default-laptop.jpg'
        };
    }

    // Save a single slot and publish to homepage
    saveSingleFeaturedSlot(slot) {
        let items = this.db.getFeaturedLaptops();
        while (items.length < 4) {
            items.push({ slot: items.length + 1, title: '', price: 0 });
        }
        items[slot - 1] = this.collectFeaturedSlotData(slot);
        this.db.saveFeaturedLaptops(items);
        this.renderHomepageFeaturedLaptops();
        this.updateFeaturedPrices();
        this.showToast(`✓ Featured Slot ${slot} saved and published to Homepage!`, 'success');
        this.forceCloudSyncAll(true);
    }

    // Save all 4 slots and publish to homepage
    saveAllAdminFeatured() {
        const items = [];
        for (let slot = 1; slot <= 4; slot++) {
            items.push(this.collectFeaturedSlotData(slot));
        }
        this.db.saveFeaturedLaptops(items);
        this.renderHomepageFeaturedLaptops();
        this.updateFeaturedPrices();
        this.showToast('✓ All 4 Featured Laptops saved and published to Homepage!', 'success');
        this.forceCloudSyncAll(true);
    }

    // Reset featured laptops back to defaults
    resetAdminFeaturedToDefaults() {
        if (confirm('Reset the homepage showcase back to the default 4 featured laptops?')) {
            safeLocalStorage.removeItem('kmap_featured_laptops');
            this.renderAdminFeatured();
            this.renderHomepageFeaturedLaptops();
            this.updateFeaturedPrices();
            this.forceCloudSyncAll(true);
        }
    }

    // Clear / revert changes in a single slot
    clearFeaturedSlot(slot) {
        const items = this.db.getFeaturedLaptops();
        const item = items[slot - 1];
        if (!item) return;

        const prodSelect = document.getElementById(`feat-slot-${slot}-prod-id`);
        const titleInput = document.getElementById(`feat-slot-${slot}-title`);
        const brandSelect = document.getElementById(`feat-slot-${slot}-brand`);
        const priceInput = document.getElementById(`feat-slot-${slot}-price`);
        const heroInput = document.getElementById(`feat-slot-${slot}-hero`);
        const specsInput = document.getElementById(`feat-slot-${slot}-specs`);
        const imgInput = document.getElementById(`feat-slot-${slot}-image`);
        const previewImg = document.getElementById(`feat-slot-${slot}-preview`);

        if (prodSelect) prodSelect.value = item.productId || '';
        if (titleInput) titleInput.value = item.title || '';
        if (brandSelect) brandSelect.value = item.brand || 'HP';
        if (priceInput) priceInput.value = item.price || 0;
        if (heroInput) heroInput.value = item.heroLabel || '';
        if (specsInput) specsInput.value = (item.specs || '').replace(/<br>/g, '\n');
        if (imgInput) imgInput.value = item.image || '';
        if (previewImg) previewImg.src = item.image || 'images/default-laptop.jpg';
    }

    // UI action aliases
    openNewHPModal() { this.openHPModal(); }
    closeNewHPModal() { this.closeHPModal(); }
    renderHP() { this.renderHPList(); }
}

// Instantiate App
const app = new KmapStoreApp();
window.app = app;

// ── Sync sticky header height to CSS variable so sub-toolbars offset correctly ──
function syncHeaderHeight() {
    const hdr = document.querySelector('.main-header');
    if (hdr && hdr.offsetHeight > 0) {
        const h = hdr.offsetHeight;
        document.documentElement.style.setProperty('--header-h', h + 'px');
        document.documentElement.style.setProperty('--main-header-height', h + 'px');
    }
}
if (typeof ResizeObserver !== 'undefined') {
    const hdr = document.querySelector('.main-header');
    if (hdr) {
        new ResizeObserver(() => syncHeaderHeight()).observe(hdr);
    }
}
// Run on load and on any resize
window.addEventListener('load', syncHeaderHeight);
window.addEventListener('resize', syncHeaderHeight);
document.addEventListener('DOMContentLoaded', syncHeaderHeight);
setTimeout(syncHeaderHeight, 100);
setTimeout(syncHeaderHeight, 300);
setTimeout(syncHeaderHeight, 800);
