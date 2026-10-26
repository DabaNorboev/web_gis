import { createApp } from 'vue';
import HomePage from './pages/HomePage.vue';

const profilePath = window.location.pathname.match(/^\/address\/([^/]+)$/);
if (window.location.pathname === '/trips') {
    import('./pages/TripsPage.vue').then(({ default: page }) => createApp(page).mount('#app'));
} else if (window.location.pathname === '/compare') {
    import('./pages/ComparePage.vue').then(({ default: page }) => createApp(page).mount('#app'));
} else if (profilePath) {
    import('./pages/AddressProfilePage.vue').then(({ default: page }) => {
        let id;
        try { id = decodeURIComponent(profilePath[1]); } catch { id = profilePath[1]; }
        createApp(page, { id }).mount('#app');
    });
} else createApp(HomePage).mount('#app');
