// Список виджетов (вкладок) — для реестра и окна настроек, без зависимостей от GNOME Shell.
export const WIDGETS = [
    {id: 'media', title: 'Музыка и видео', subtitle: 'Плеер для любого приложения: обложка, прогресс, управление, выбор устройства', icon: 'audio-x-generic-symbolic'},
    {id: 'calendar', title: 'Календарь и погода', subtitle: 'Ближайшие события и погода из приложений GNOME', icon: 'x-office-calendar-symbolic'},
    {id: 'audio', title: 'Звук', subtitle: 'Устройства вывода и громкость отдельно для каждого приложения', icon: 'audio-speakers-symbolic'},
    {id: 'shelf', title: 'Полка файлов', subtitle: 'Скопированные или перетащенные на каплю файлы', icon: 'folder-symbolic'},
    {id: 'clipboard', title: 'Буфер обмена', subtitle: 'Последние записи из Clipboard History', icon: 'edit-paste-symbolic'},
    {id: 'notes', title: 'Заметки', subtitle: 'Быстрый блокнот, сохраняется сам', icon: 'document-edit-symbolic'},
    {id: 'pomodoro', title: 'Таймер Pomodoro', subtitle: 'Фокус и перерывы, обратный отсчёт прямо в капле', icon: 'alarm-symbolic'},
    {id: 'system', title: 'Система', subtitle: 'Процессор, память, диск, батарея, сеть', icon: 'computer-symbolic'},
];
