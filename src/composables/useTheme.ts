/**
 * 主题（暗色 / 亮色 / 跟随系统）
 * ---------------------------------------------------------------
 * - 统一给 <html> 加 dark / light 类，Element Plus 的暗色变量随之生效；
 * - 自定义配色通过 CSS 变量下发，各面板不再写死颜色；
 * - 「跟随系统」会监听 prefers-color-scheme 变化（宿主 WebView 跟随系统时即自动切换）。
 */
import { ref, watch } from 'vue';
import { loadState, saveState } from '@/platform/host';

export type ThemeMode = 'dark' | 'light' | 'system';

const STORAGE_KEY = 'compositor.theme';

/** 用户选择的模式 */
export const themeMode = ref<ThemeMode>('dark');

/** 系统当前偏好是否为亮色 */
const systemPrefersLight = ref(false);

/** 当前实际生效的主题 */
export const effectiveTheme = ref<'dark' | 'light'>('dark');

/** 应用主题到 <html> */
function apply(): void {
  const theme = themeMode.value === 'system'
    ? (systemPrefersLight.value ? 'light' : 'dark')
    : themeMode.value;
  effectiveTheme.value = theme;
  const root = document.documentElement;
  root.classList.toggle('dark', theme === 'dark');
  root.classList.toggle('light', theme === 'light');
  root.style.colorScheme = theme;
}

/** 读取持久化设置并开始监听系统主题 */
export async function initTheme(): Promise<void> {
  const saved = await loadState<ThemeMode>(STORAGE_KEY, 'dark');
  themeMode.value = saved === 'light' || saved === 'system' ? saved : 'dark';
  if (typeof window.matchMedia === 'function') {
    const query = window.matchMedia('(prefers-color-scheme: light)');
    systemPrefersLight.value = query.matches;
    query.addEventListener('change', (event) => {
      systemPrefersLight.value = event.matches;
      apply();
    });
  }
  apply();
}

/** 切换主题模式 */
export function setTheme(mode: ThemeMode): void {
  themeMode.value = mode;
  void saveState(STORAGE_KEY, mode);
  apply();
}

/** 在暗色 / 亮色之间切换（跟随系统时先落到当前实际主题的对面） */
export function toggleTheme(): void {
  setTheme(effectiveTheme.value === 'dark' ? 'light' : 'dark');
}

/** 供界面显示的名称 */
export const themeLabel: Record<ThemeMode, string> = {
  dark: '暗色',
  light: '亮色',
  system: '跟随系统',
};

watch(themeMode, apply);
