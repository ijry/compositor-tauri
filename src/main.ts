import { createApp } from 'vue';
import ElementPlus from 'element-plus';
import 'element-plus/dist/index.css';
import 'virtual:uno.css';
import App from './App.vue';
import './style.css';

createApp(App).use(ElementPlus, { size: 'small' }).mount('#app');

