<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>VirtualPLC Studio</title>
    
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
    
    <script src="https://cdnjs.cloudflare.com/ajax/libs/ace/1.32.7/ace.js"></script>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/ace/1.32.7/ext-language_tools.min.js"></script>

    <style>
        /* --- THEME VARIABLES (Dark Default) --- */
        :root {
            --bg-app: #18181b;       
            --bg-sidebar: #202023;   
            --bg-panel: #1e1e1e;     
            --bg-header: #2d2d2d;
            --bg-hover: rgba(255, 255, 255, 0.04);
            --bg-active: rgba(255, 255, 255, 0.08);
            --bg-input: #2d2d30;
            
            --accent-primary: #3b82f6; 
            --accent-hover: #2563eb;
            --accent-dim: rgba(59, 130, 246, 0.15);
            
            --status-success: #10b981; 
            --status-error: #ef4444;   
            --status-info: #3b82f6;
            --status-warn: #eab308;

            --syntax-bool: #569cd6;
            --syntax-int: #b5cea8;
            
            --border-subtle: rgba(255, 255, 255, 0.07);
            --border-strong: rgba(255, 255, 255, 0.12);

            --text-main: #e4e4e7;
            --text-muted: #a1a1aa;
            --text-faint: #52525b;

            --radius-sm: 4px;
            --radius-md: 6px;
            --font-ui: 'Inter', system-ui, sans-serif;
            --font-code: 'JetBrains Mono', monospace;
            
            --editor-font-size: 14px;
        }

        /* --- LIGHT THEME OVERRIDES --- */
        [data-theme="light"] {
            --bg-app: #f3f4f6;
            --bg-sidebar: #e5e7eb;
            --bg-panel: #ffffff;
            --bg-header: #d1d5db;
            --bg-hover: rgba(0, 0, 0, 0.05);
            --bg-active: rgba(0, 0, 0, 0.1);
            --bg-input: #ffffff;
            --text-main: #1f2937;
            --text-muted: #6b7280;
            --text-faint: #9ca3af;
            --border-subtle: #d1d5db;
            --border-strong: #9ca3af;
            --syntax-bool: #0000ff;
            --syntax-int: #098658;
        }
        /* Editor Theme Adjustments */
        [data-theme="light"] .ace_editor { background-color: #ffffff; color: #000000; }
        [data-theme="light"] .ace_gutter { background-color: #f3f4f6; color: #6b7280; }

        /* --- RESET --- */
        * { box-sizing: border-box; outline: none; }
        body { 
            margin: 0; padding: 0; 
            font-family: var(--font-ui); 
            background: var(--bg-app); 
            color: var(--text-main); 
            height: 100vh; overflow: hidden; 
            font-size: 13px; user-select: none;
        }

        /* --- ICONS --- */
        svg { fill: currentColor; display: block; }

        /* --- LAYOUT --- */
        .app-container {
            display: grid;
            grid-template-columns: 50px 240px 1fr; 
            grid-template-rows: 1fr 150px 24px; 
            height: 100vh; width: 100vw;
            transition: grid-template-columns 0.2s ease, grid-template-rows 0.2s ease;
        }
        .app-container.terminal-closed { grid-template-rows: 1fr 0px 24px; }
        .app-container.sidebar-closed { grid-template-columns: 50px 0px 1fr; }

        /* 1. ACTIVITY BAR */
        .activity-bar {
            grid-column: 1; grid-row: 1 / span 3;
            background: var(--bg-app);
            border-right: 1px solid var(--border-subtle);
            display: flex; flex-direction: column; align-items: center;
            padding-top: 12px; z-index: 20;
        }
        .activity-icon {
            width: 50px; height: 50px;
            display: flex; justify-content: center; align-items: center;
            cursor: pointer; position: relative; color: var(--text-muted);
            transition: color 0.2s;
        }
        .activity-icon svg { width: 24px; height: 24px; }
        .activity-icon:hover, .activity-icon.active { color: var(--text-main); }
        .activity-icon.active::before {
            content: ''; position: absolute; left: 0; top: 12px; bottom: 12px;
            width: 3px; background: var(--accent-primary); border-radius: 0 4px 4px 0;
        }

        /* 2. SIDEBAR */
        .sidebar {
            grid-column: 2; grid-row: 1 / span 2;
            background: var(--bg-sidebar);
            border-right: 1px solid var(--border-subtle);
            display: flex; flex-direction: column;
            position: relative; overflow: hidden;
            min-width: 0; 
        }
        .sidebar-header {
            height: 44px; padding: 0 16px; min-height: 44px;
            display: flex; align-items: center; justify-content: space-between;
            font-size: 11px; font-weight: 600; 
            color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.8px;
        }
        
        .sidebar-search { padding: 0 10px 8px 10px; }
        .sidebar-search input {
            background: var(--bg-input); border: 1px solid var(--border-subtle);
            width: 100%; padding: 4px 8px; border-radius: 4px; color: var(--text-main);
            font-size: 12px;
        }
        .sidebar-search input:focus { border-color: var(--accent-primary); }

        .tree-view { flex: 1; overflow-y: auto; padding: 0 8px 8px 8px; }
        .tree-section-title {
            padding: 12px 4px 6px; font-size: 10px; font-weight: 700;
            color: var(--text-faint); text-transform: uppercase; letter-spacing: 0.5px;
        }
        
        .tree-item {
            padding: 6px 12px; margin-bottom: 2px;
            border-radius: var(--radius-sm); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
            cursor: pointer; display: flex; align-items: center; gap: 8px;
            color: var(--text-muted); transition: all 0.15s ease;
            font-size: 13px; position: relative;
        }
        .tree-item:hover { background: var(--bg-hover); color: var(--text-main); }
        .tree-item.active { background: var(--bg-active); color: var(--text-main); font-weight: 500; }
        .tree-item.hidden { display: none; }
        .tree-icon { opacity: 0.8; width: 16px; height: 16px; min-width: 16px; display:flex; align-items:center; justify-content:center; }
        .tree-icon svg { width: 15px; height: 15px; }
        .tree-item.modified .tree-icon { color: var(--status-warn); }

        .tree-delete {
            margin-left: auto; background: transparent; border: none;
            color: var(--text-faint); cursor: pointer; padding: 4px;
            border-radius: 4px; display: flex; align-items: center; justify-content: center;
            opacity: 0; transition: all 0.2s;
        }
        .tree-delete svg { width: 14px; height: 14px; }
        .tree-item:hover .tree-delete { opacity: 1; }
        .tree-delete:hover { background: rgba(239, 68, 68, 0.2); color: var(--status-error); }

        .resizer {
            width: 4px; cursor: col-resize; position: absolute;
            top: 0; right: 0; bottom: 0; z-index: 100;
            transition: background 0.2s;
        }
        .resizer:hover, .resizer.resizing { background: var(--accent-primary); }

        /* 3. MAIN AREA */
        .main-area {
            grid-column: 3; grid-row: 1;
            display: flex; flex-direction: column;
            background: var(--bg-panel); overflow: hidden;
            position: relative;
        }

        .editor-tabs {
            height: 36px; background: var(--bg-sidebar);
            display: flex; align-items: flex-end;
            border-bottom: 1px solid var(--border-subtle);
            overflow-x: auto; scrollbar-width: none;
        }
        .tab {
            padding: 8px 16px; min-width: 140px; height: 100%;
            display: flex; align-items: center; gap: 8px;
            background: transparent; 
            border-right: 1px solid var(--border-subtle);
            border-top: 2px solid transparent;
            cursor: pointer; color: var(--text-muted); font-size: 12px;
            transition: background 0.1s;
        }
        .tab:hover { background: var(--bg-hover); }
        .tab.active { 
            background: var(--bg-panel); 
            color: var(--text-main); 
            border-top-color: var(--accent-primary);
        }
        .tab-icon svg { width: 14px; height: 14px; fill: var(--accent-primary); }

        .action-bar {
            height: 48px; border-bottom: 1px solid var(--border-subtle);
            display: flex; align-items: center; justify-content: space-between;
            padding: 0 24px; background: var(--bg-panel);
        }
        .breadcrumb { display: flex; align-items: center; gap: 8px; color: var(--text-muted); font-size: 13px; }
        .breadcrumb span.current { color: var(--text-main); font-weight: 500; }

        .content-view { 
            flex: 1; padding: 24px 32px; overflow-y: auto; display: none; 
            background: var(--bg-panel);
        }
        .content-view.active { display: block; animation: fadeIn 0.2s ease-out; }
        
        table { width: 100%; border-collapse: separate; border-spacing: 0; font-size: 13px; table-layout: fixed; }
        th { 
            text-align: left; padding: 8px 12px; 
            color: var(--text-muted); font-size: 11px; font-weight: 600; 
            border-bottom: 1px solid var(--border-strong); text-transform: uppercase; letter-spacing: 0.5px;
        }
        td { 
            border-bottom: 1px solid var(--border-subtle); 
            height: 40px; padding: 0 4px; vertical-align: middle;
        }
        tr:hover td { background: var(--bg-hover); }
        td input, td select {
            background: transparent; border: 1px solid transparent; 
            color: var(--text-main); padding: 6px 8px; 
            font-family: inherit; font-size: 13px; width: 100%; 
            border-radius: var(--radius-sm); transition: all 0.1s;
        }
        td input:hover, td select:hover { background: rgba(255,255,255,0.03); border-color: var(--border-subtle); }
        td input:focus, td select:focus { 
            background: var(--bg-app); 
            border-color: var(--accent-primary); 
            box-shadow: 0 0 0 2px var(--accent-dim);
        }
        
        .force-val:hover { text-decoration: underline; background: rgba(255,255,255,0.1); border-radius: 4px; padding: 2px 4px; }

        .btn-group { display: flex; gap: 8px; }
        .btn {
            background: var(--accent-primary); color: white; border: none;
            padding: 0 14px; height: 30px; border-radius: var(--radius-md); 
            cursor: pointer; font-size: 12px; font-weight: 500; 
            display: inline-flex; align-items: center; gap: 8px; 
            transition: all 0.2s;
        }
        .btn:hover { background: var(--accent-hover); }
        .btn svg { width: 16px; height: 16px; }
        .btn-secondary { background: rgba(255,255,255,0.06); color: var(--text-main); border: 1px solid transparent; }
        .btn-secondary:hover { background: rgba(255,255,255,0.1); border-color: var(--border-subtle); }
        .btn-icon {
            background: transparent; border: none; width: 28px; height: 28px;
            color: var(--text-muted); border-radius: var(--radius-sm); cursor: pointer; 
            display: flex; align-items: center; justify-content: center; transition: all 0.2s;
        }
        .btn-icon:hover { color: var(--status-error); background: rgba(239, 68, 68, 0.1); }
        .btn-icon-std:hover { color: var(--text-main); background: rgba(255,255,255,0.1); }
        .btn-icon svg { width: 16px; height: 16px; }

        .badge { font-family: var(--font-code); font-size: 11px; font-weight: 500; padding: 2px 8px; border-radius: 12px; display: inline-block; }
        .badge-bool { color: var(--syntax-bool); background: rgba(86, 156, 214, 0.1); border: 1px solid rgba(86, 156, 214, 0.2); }
        .badge-int { color: var(--syntax-int); background: rgba(181, 206, 168, 0.1); border: 1px solid rgba(181, 206, 168, 0.2); }

        .editor-container { position: relative; width: 100%; height: 100%; }
        #editor { position: absolute; top: 0; right: 0; bottom: 0; left: 0; font-size: var(--editor-font-size); font-family: 'JetBrains Mono', monospace; }

        /* --- TERMINAL PANEL --- */
        .terminal-panel {
            grid-column: 3; grid-row: 2;
            border-top: 1px solid var(--border-subtle);
            background: var(--bg-app);
            display: flex; flex-direction: column; overflow: hidden;
        }
        .terminal-header {
            padding: 0 16px; height: 32px; display: flex; align-items: center;
            background: var(--bg-sidebar); font-size: 11px; text-transform: uppercase;
            border-bottom: 1px solid var(--border-subtle); font-weight: 600; color: var(--text-muted); letter-spacing: 0.5px;
        }
        .terminal-content {
            flex: 1; overflow-y: auto; padding: 12px 16px;
            font-family: 'JetBrains Mono', monospace; font-size: 12px; color: var(--text-muted); line-height: 1.5;
        }
        .log-info { color: var(--text-main); }
        .log-success { color: var(--status-success); }
        .log-error { color: var(--status-error); }
        .log-warn { color: var(--status-warn); }

        /* --- OVERLAYS --- */
        .ctx-menu {
            position: fixed; background: #252526; border: 1px solid var(--border-subtle);
            box-shadow: 0 4px 12px rgba(0,0,0,0.4); border-radius: 4px; z-index: 5000;
            display: none; min-width: 160px; padding: 4px 0;
        }
        .ctx-menu.visible { display: block; }
        .ctx-item {
            padding: 8px 16px; font-size: 13px; color: var(--text-main); cursor: pointer;
            display: flex; align-items: center; gap: 8px;
        }
        .ctx-item:hover { background: var(--accent-primary); color: white; }
        .ctx-divider { height: 1px; background: var(--border-subtle); margin: 4px 0; }

        .toast-container {
            position: fixed; bottom: 40px; right: 20px;
            display: flex; flex-direction: column; gap: 10px; z-index: 1000;
        }
        .toast {
            background: #252526; border: 1px solid var(--border-subtle);
            color: var(--text-main); padding: 12px 16px; border-radius: 4px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.3); font-size: 13px;
            display: flex; align-items: center; gap: 12px;
            animation: slideIn 0.3s cubic-bezier(0.16, 1, 0.3, 1);
            min-width: 300px;
        }
        .toast-success { border-left: 3px solid var(--status-success); }
        .toast-error { border-left: 3px solid var(--status-error); }
        .toast-info { border-left: 3px solid var(--status-info); }

        .modal-overlay {
            position: fixed; top: 0; left: 0; right: 0; bottom: 0;
            background: rgba(0,0,0,0.6); z-index: 2000;
            display: flex; align-items: center; justify-content: center;
            backdrop-filter: blur(2px);
            opacity: 0; pointer-events: none; transition: opacity 0.2s;
        }
        .modal-overlay.open { opacity: 1; pointer-events: all; }
        .modal {
            background: var(--bg-panel); border: 1px solid var(--border-subtle);
            width: 400px; border-radius: 6px; box-shadow: 0 10px 30px rgba(0,0,0,0.5);
            padding: 24px; transform: translateY(10px); transition: transform 0.2s;
        }
        .modal-overlay.open .modal { transform: translateY(0); }
        .modal h3 { margin: 0 0 16px 0; font-size: 14px; color: var(--text-main); font-weight: 600; }
        .modal input, .modal select { 
            background: var(--bg-input); border: 1px solid var(--border-strong);
            padding: 10px; width: 100%; color: white; border-radius: 4px;
            font-size: 13px; outline: none; margin-bottom: 10px;
        }
        .modal label { font-size: 12px; color: var(--text-muted); display: block; margin-bottom: 5px; }
        .modal input:focus, .modal select:focus { border-color: var(--accent-primary); }
        .modal-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 20px; }

        .live-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--text-faint); display: inline-block; transition: 0.3s; }
        .live-dot.active { background: var(--status-success); box-shadow: 0 0 0 4px rgba(16, 185, 129, 0.2); }

        .status-bar { grid-column: 1 / span 3; grid-row: 3; background: var(--accent-primary); color: white; display: flex; align-items: center; padding: 0 16px; font-size: 11px; font-weight: 500; justify-content: space-between; z-index: 50; }
        .status-btn { background: rgba(0,0,0,0.2); border: none; color: white; padding: 2px 8px; border-radius: 3px; cursor: pointer; margin-left: 10px; font-size: 10px;}
        .status-btn:hover { background: rgba(0,0,0,0.4); }

        @keyframes fadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes slideIn { from { transform: translateY(20px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
        @keyframes fadeOut { to { opacity: 0; transform: translateY(10px); } }
        
        .flex-row { display: flex; align-items: center; gap: 8px; width: 100%; }
        .text-mono { font-family: var(--font-code); font-size: 12px; }
        .spacer { flex: 1; }
    </style>
</head>
<body>

    <div class="app-container" id="app-container">
        <input type="file" id="file-upload" style="display:none" accept=".json" onchange="handleFileUpload(this)">

        <div class="activity-bar">
            <div class="activity-icon active" title="Explorer" onclick="toggleSidebar()">
                <svg viewBox="0 0 24 24"><path d="M20 6h-8l-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm0 12H4V8h16v10z"/></svg>
            </div>
            <div class="spacer"></div>
            <div class="activity-icon" title="Settings" onclick="openSettings()">
                <svg viewBox="0 0 24 24"><path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L3.16 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.04.64.09.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg>
            </div>
        </div>

        <div class="sidebar">
            <div class="sidebar-header">
                <span>Explorer</span>
                <div class="btn-group">
                    <button class="btn-icon btn-icon-std" title="Export Project" onclick="downloadProject()">
                        <svg style="width:14px;height:14px" viewBox="0 0 24 24"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
                    </button>
                    <button class="btn-icon btn-icon-std" title="Import Project" onclick="document.getElementById('file-upload').click()">
                        <svg style="width:14px;height:14px" viewBox="0 0 24 24"><path d="M9 16h6v-6h4l-7-7-7 7h4zm-4 2h14v2H5z"/></svg>
                    </button>
                    <button class="btn-icon btn-icon-std" title="Reload from Server" onclick="loadProject()">
                        <svg style="width:14px;height:14px" viewBox="0 0 24 24"><path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z"/></svg>
                    </button>
                </div>
            </div>
            
            <div class="sidebar-search">
                <input type="text" placeholder="Filter..." oninput="filterTree(this.value)">
            </div>

            <div class="tree-view">
                <div class="tree-section-title">Configuration</div>
                <div class="tree-item active" onclick="nav('hw', this)">
                    <span class="tree-icon" id="icon-hw"></span> Hardware
                </div>
                <div class="tree-item" onclick="nav('vars', this)">
                    <span class="tree-icon" id="icon-tags"></span> PLC Tags
                </div>
                <div class="tree-item" onclick="nav('db', this)">
                    <span class="tree-icon" id="icon-db"></span> Data Blocks
                </div>
                
                <div class="tree-section-title">Program Blocks</div>
                <div class="tree-item" onclick="nav('fc', this)">
                    <span class="tree-icon" id="icon-fc"></span> Main FC
                </div>
                <div id="block-tree-list"></div>
                
                <div class="tree-item" style="color:var(--accent-primary); margin-top:8px;" onclick="promptNewBlock()">
                    <span class="tree-icon" style="font-weight:bold; font-size:18px">+</span> Add Block
                </div>
            </div>
            <div class="resizer" id="drag-handle"></div>
        </div>

        <div class="main-area">
            
            <div class="editor-tabs" id="tab-container">
                <div class="tab active">
                    <span class="tab-icon" id="tab-icon"></span> <span id="tab-title">Hardware</span>
                </div>
            </div>

            <div class="action-bar">
                <div class="breadcrumb">
                    <span>Project</span> <span>/</span> <span id="crumb-title" class="current">Hardware Configuration</span>
                </div>
                <div class="btn-group">
                    <span id="dynamic-actions" style="display:contents"></span>
                    
                    <button class="btn btn-secondary" onclick="saveProject()">
                        <svg viewBox="0 0 24 24"><path d="M17 3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V7l-4-4zm-5 16c-1.66 0-3-1.34-3-3s1.34-3 3-3 3 1.34 3 3-1.34 3-3 3zm3-10H5V5h10v4z"/></svg>
                        Save
                    </button>
                    <button class="btn" onclick="deploy()">
                        <svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
                        Deploy
                    </button>
                </div>
            </div>

            <div id="view-hw" class="content-view active">
                <table id="hw-table">
                    <thead><tr><th style="width:25%">Device Name</th><th style="width:25%">IP Address</th><th style="width:15%">Port</th><th style="width:15%">Slave ID</th><th style="width:40px"></th></tr></thead>
                    <tbody></tbody>
                </table>
                <button class="btn btn-secondary" style="margin-top:20px" onclick="addHw()">+ Add Device</button>
            </div>

            <div id="view-vars" class="content-view">
                <div style="display:flex; justify-content:space-between; margin-bottom:20px; align-items:center">
                    <span style="font-size:13px; color:var(--text-muted)">Define global variables and map I/O.</span>
                    <button id="btn-live" class="btn btn-secondary" onclick="toggleLiveMode()">
                        <span class="live-dot" style="margin-right:8px"></span> Live Monitor
                    </button>
                </div>
                <table id="vars-table">
                    <thead><tr><th style="width:50px; text-align:center">Stat</th><th style="width:20%">Tag Name</th><th style="width:20%">Type / Mode</th><th>Address / Mapping</th><th style="width:15%">Value</th><th style="width:40px"></th></tr></thead>
                    <tbody></tbody>
                </table>
                <button class="btn btn-secondary" style="margin-top:20px" onclick="addVar()">+ Add Tag</button>
            </div>

            <div id="view-db" class="content-view">
                <table id="db-table">
                    <thead><tr><th style="width:40%">Variable Name</th><th>Initial Value</th><th style="width:40px"></th></tr></thead>
                    <tbody></tbody>
                </table>
                <button class="btn btn-secondary" style="margin-top:20px" onclick="addDb()">+ Add Init Value</button>
            </div>

            <div id="view-code" class="content-view" style="padding:0; overflow:hidden;">
                <div class="editor-container">
                    <div id="editor"></div>
                </div>
            </div>
        </div>

        <div class="terminal-panel">
            <div class="terminal-header">
                <span>Output / Logs</span>
                <button class="btn-icon" style="margin-left:auto" onclick="document.getElementById('console-out').innerHTML=''" title="Clear Output">
                    <svg style="width:14px;height:14px" viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
                </button>
            </div>
            <div class="terminal-content" id="console-out">
                <div class="log-info">System ready. Waiting for user action...</div>
            </div>
        </div>

        <div class="status-bar">
            <div class="status-item" id="status-msg">Ready</div>
            <div class="status-item">
                <button class="status-btn" onclick="toggleTerminal()">Toggle Terminal</button>
            </div>
            <div class="status-item" id="connection-indicator">
                <span style="width:6px;height:6px;border-radius:50%;background:rgba(255,255,255,0.6)"></span>
                Initializing...
            </div>
        </div>
    </div>
    
    <div class="toast-container" id="toast-container"></div>
    
    <div id="ctx-menu" class="ctx-menu">
        <div class="ctx-item" onclick="handleCtxAction('open')">Open</div>
        <div class="ctx-divider"></div>
        <div class="ctx-item" onclick="handleCtxAction('rename')">Rename</div>
        <div class="ctx-item" onclick="handleCtxAction('duplicate')">Duplicate</div>
        <div class="ctx-divider"></div>
        <div class="ctx-item" onclick="handleCtxAction('delete')" style="color:var(--status-error)">Delete</div>
    </div>

    <div class="modal-overlay" id="modal-overlay">
        <div class="modal">
            <h3 id="modal-title">Enter Value</h3>
            <div class="modal-body" id="modal-body">
                <input type="text" id="modal-input" autofocus>
            </div>
            <div class="modal-actions" id="modal-actions">
                <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
                <button class="btn" id="modal-confirm">Confirm</button>
            </div>
        </div>
    </div>

    <script>
        // --- ICONS ---
        const ICONS = {
            hw: '<svg viewBox="0 0 24 24"><path d="M2 20h20v-4H2v4zm2-3h2v2H4v-2zM2 4v4h20V4H2zm4 3H4V5h2v2zm-4 7h20v-4H2v4zm2-3h2v2H4v-2z"/></svg>',
            tag: '<svg viewBox="0 0 24 24"><path d="M21.41 11.58l-9-9C12.05 2.22 11.55 2 11 2H4c-1.1 0-2 .9-2 2v7c0 .55.22 1.05.59 1.42l9 9c.36.36.86.58 1.41.58.55 0 1.05-.22 1.41-.59l7-7c.37-.36.59-.86.59-1.41 0-.55-.23-1.06-.59-1.42zM5.5 7C4.67 7 4 6.33 4 5.5S4.67 4 5.5 4 7 4.67 7 5.5 6.33 7 5.5 7z"/></svg>',
            db: '<svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 3c1.66 0 3 1.34 3 3s-1.34 3-3 3-3-1.34-3-3 1.34-3 3-3zm0 14.2c-2.5 0-4.71-1.28-6-3.22.03-1.99 4-3.08 6-3.08 1.99 0 5.97 1.09 6 3.08-1.29 1.94-3.5 3.22-6 3.22z"/></svg>',
            fc: '<svg viewBox="0 0 24 24"><path d="M9.4 16.6L4.8 12l4.6-4.6L8 6l-6 6 6 6 1.4-1.4zm5.2 0l4.6-4.6-4.6-4.6L16 6l6 6-6 6-1.4-1.4z"/></svg>',
            file: '<svg viewBox="0 0 24 24"><path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/></svg>',
            trash: '<svg viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>'
        };

        // --- STATE ---
        let project = { hardware: [], vars: [], db: [], blocks: [], fc: "(* Main Cyclic Logic *)\n\nWHILE TRUE DO\n    WAIT(100);\nEND_WHILE;" };
        let currentContext = 'fc'; 
        let currentContextName = 'Main FC';
        let liveInterval = null;
        let aceEditor = null;
        let isDirty = false;
        let modalCallback = null;
        let ctxTargetIndex = null;
        let dragSrcEl = null;
        let settings = { fontSize: 14, theme: 'dark' };

        // --- INIT ---
        window.onload = function() {
            // Icons
            document.getElementById('icon-hw').innerHTML = ICONS.hw;
            document.getElementById('icon-tags').innerHTML = ICONS.tag;
            document.getElementById('icon-db').innerHTML = ICONS.db;
            document.getElementById('icon-fc').innerHTML = ICONS.fc;
            document.getElementById('tab-icon').innerHTML = ICONS.hw;

            initAce();
            initResizer();
            loadProject();
            
            document.addEventListener('click', () => document.getElementById('ctx-menu').classList.remove('visible'));
        };

        // --- ACE EDITOR ---
        function initAce() {
            ace.require("ace/ext/language_tools");
            const snippetManager = ace.require("ace/snippets").snippetManager;
            aceEditor = ace.edit("editor");
            aceEditor.setOptions({
                enableBasicAutocompletion: true,
                enableLiveAutocompletion: true,
                theme: "ace/theme/dracula",
                mode: "ace/mode/pascal",
                fontSize: settings.fontSize + "px",
                showPrintMargin: false,
            });
            
            const snippets = [
                { content: "IF ${1:condition} THEN\n\t${2:statement};\nEND_IF;", name: "IF", tabTrigger: "if" },
                { content: "IF ${1:condition} THEN\n\t${2:statement};\nELSE\n\t${3:statement};\nEND_IF;", name: "IF_ELSE", tabTrigger: "ifelse" },
                { content: "WHILE ${1:condition} DO\n\t${2:statement};\nEND_WHILE;", name: "WHILE", tabTrigger: "while" },
                { content: "FOR ${1:i} := ${2:0} TO ${3:10} DO\n\t${4:statement};\nEND_FOR;", name: "FOR", tabTrigger: "for" },
                { content: "CASE ${1:var} OF\n\t${2:1}: ${3:statement};\nELSE\n\t${4:statement};\nEND_CASE;", name: "CASE", tabTrigger: "case" }
            ];
            snippetManager.register(snippets, "pascal");

            const customCompleter = {
                getCompletions: function(editor, session, pos, prefix, callback) {
                    const keywords = project.vars.map(v => ({
                        caption: v.name, value: v.name, meta: v.type, score: 1000
                    }));
                    callback(null, keywords);
                }
            };
            aceEditor.completers.push(customCompleter);
            
            aceEditor.session.on('change', function() {
                const val = aceEditor.getValue();
                if (currentContext === 'fc') project.fc = val;
                else if (project.blocks[currentContext]) project.blocks[currentContext].code = val;
                
                if(!isDirty) {
                    isDirty = true;
                    document.getElementById('crumb-title').innerText = currentContextName + " ●";
                    if(typeof currentContext === 'number') {
                        const item = document.querySelector(`.tree-item[data-idx="${currentContext}"]`);
                        if(item) item.classList.add('modified');
                    }
                }
            });
        }

        // --- SIDEBAR RESIZER & FILTER ---
        function initResizer() {
            const resizer = document.getElementById('drag-handle');
            let isResizing = false;
            resizer.addEventListener('mousedown', (e) => { isResizing = true; resizer.classList.add('resizing'); document.body.style.cursor = 'col-resize'; });
            document.addEventListener('mousemove', (e) => {
                if (!isResizing) return;
                const newWidth = Math.max(150, Math.min(e.clientX - 50, 600));
                document.querySelector('.app-container').style.gridTemplateColumns = `50px ${newWidth}px 1fr`;
            });
            document.addEventListener('mouseup', () => { isResizing = false; resizer.classList.remove('resizing'); document.body.style.cursor = 'default'; });
        }

        function filterTree(val) {
            const items = document.querySelectorAll('#block-tree-list .tree-item');
            items.forEach(el => {
                const text = el.innerText.toLowerCase();
                el.classList.toggle('hidden', !text.includes(val.toLowerCase()));
            });
        }
        
        function toggleSidebar() {
            document.getElementById('app-container').classList.toggle('sidebar-closed');
            setTimeout(() => aceEditor.resize(), 300);
        }

        function formatCode() {
            const val = aceEditor.getValue();
            const lines = val.split('\n');
            let indent = 0;
            const formatted = lines.map(line => {
                const trimmed = line.trim();
                if (trimmed.startsWith('END_') || trimmed.startsWith('ELSE') || trimmed.startsWith('ELSIF')) indent = Math.max(0, indent - 1);
                const newLine = '\t'.repeat(indent) + trimmed;
                if (trimmed.endsWith('THEN') || trimmed.endsWith('DO') || trimmed.endsWith('ELSE') || trimmed.startsWith('VAR')) indent++;
                if (trimmed.endsWith('END_VAR')) indent = Math.max(0, indent - 1);
                return newLine;
            }).join('\n');
            aceEditor.setValue(formatted, -1);
            showToast("Code Formatted", "success");
        }

        // --- IMPORT / EXPORT ---
        function downloadProject() {
            const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(project, null, 2));
            const downloadAnchorNode = document.createElement('a');
            downloadAnchorNode.setAttribute("href", dataStr);
            downloadAnchorNode.setAttribute("download", "openplc_project.json");
            document.body.appendChild(downloadAnchorNode);
            downloadAnchorNode.click(); downloadAnchorNode.remove();
            log("Project exported to JSON.", "success");
        }

        function handleFileUpload(input) {
            const file = input.files[0]; if (!file) return;
            const reader = new FileReader();
            reader.onload = function(e) {
                try {
                    const json = JSON.parse(e.target.result);
                    if (json.hardware && json.blocks) {
                        project = json; renderAll(); nav('hw'); saveProject();
                        log("Project imported successfully.", "success"); showToast("Project Imported", "success");
                    } else { throw new Error("Invalid Project File"); }
                } catch (err) { showToast("Import Failed: " + err.message, "error"); }
            };
            reader.readAsText(file); input.value = '';
        }

        // --- API & ACTIONS ---
        async function loadProject() {
            log("Loading Project...", "info");
            setStatus("Loading...");
            try {
                const res = await fetch('api.php?action=load');
                const data = await res.json();
                if(data && typeof data === 'object') project = { ...project, ...data };
                renderAll();
                log("Project Loaded.", "success");
                setStatus("Ready");
            } catch (err) {
                log("Failed to load project. Starting new session.", "warn");
                renderAll();
                setStatus("Ready (Local)");
            }
        }

        async function saveProject() {
            setStatus("Saving...");
            try {
                const res = await fetch('api.php?action=save', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(project) });
                const resp = await res.json();
                if(resp.status === 'success') {
                    setStatus("Ready");
                    showToast("Project saved successfully", "success");
                    log("Project saved.", "success");
                    isDirty = false;
                    document.getElementById('crumb-title').innerText = currentContextName;
                    document.querySelectorAll('.modified').forEach(el => el.classList.remove('modified'));
                } else {
                    throw new Error(resp.message);
                }
            } catch (e) {
                setStatus("Save Failed");
                showToast("Save Failed: " + e.message, "error");
                log("Save Error: " + e.message, "error");
            }
        }

        async function deploy() {
            // Simulated Build
            setStatus("Compiling...");
            document.getElementById('console-out').innerHTML = '';
            const app = document.getElementById('app-container');
            app.classList.remove('terminal-closed');
            
            const steps = [
                { msg: "Clicked on Deploy Button...", type: "info", delay: 100 },
                { msg: "Going to send to backend, you know ?", type: "info", delay: 400 }
            ];

            for (const step of steps) {
                log(step.msg, step.type);
                await new Promise(r => setTimeout(r, 400));
            }

            try {
                log("Uploading to Runtime...", "warn");
                const res = await fetch('api.php?action=deploy', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(project) });
                const resp = await res.json();
                if(resp.status === 'success') {
                    log("Build Successful. Runtime Restarted.", "success");
                    setStatus("Ready");
                    showToast("Deployment Complete", "success");
                    setTimeout(loadProject, 1000); 
                } else {
                    throw new Error(resp.error);
                }
            } catch (e) {
                log("Build Failed: " + e.message, "error");
                setStatus("Build Failed");
            }
        }

        async function forceVar(tagName, value) {
            if(!liveInterval) return;
            log(`Forcing ${tagName} to ${value}...`, "info");
            try {
                const res = await fetch('api.php?action=write', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ tag: tagName, value: value }) });
                const json = await res.json();
                if(json.status === 'success') showToast(`${tagName} updated`, "success");
            } catch(e) { showToast("Failed to write value", "error"); }
        }

        // --- NAVIGATION ---
        function nav(view, el = null, blockIdx = null) {
            if(el) {
                document.querySelectorAll('.tree-item').forEach(item => item.classList.remove('active'));
                el.classList.add('active');
            }

            document.querySelectorAll('.content-view').forEach(e => e.classList.remove('active'));
            if(view !== 'vars') stopLiveMode();

            const tabTitle = document.getElementById('tab-title');
            const crumb = document.getElementById('crumb-title');
            const iconContainer = document.getElementById('tab-icon');
            const dynamicActions = document.getElementById('dynamic-actions');
            dynamicActions.innerHTML = '';

            const setView = (title, icon, name) => {
                document.getElementById('view-' + (view === 'block' || view === 'fc' ? 'code' : view)).classList.add('active');
                tabTitle.innerText = title; crumb.innerText = name; 
                iconContainer.innerHTML = icon; currentContextName = name;
            };

            if (view === 'hw') { setView("Hardware", ICONS.hw, "Hardware Configuration"); renderHW(); }
            else if (view === 'vars') { setView("PLC Tags", ICONS.tag, "Tag Table"); renderVars(); }
            else if (view === 'db') { setView("Data Blocks", ICONS.db, "Data Blocks"); renderDB(); }
            else if (view === 'fc' || view === 'block') {
                const name = view === 'fc' ? "Main Program (FC)" : "Block: " + project.blocks[blockIdx].name;
                const icon = view === 'fc' ? ICONS.fc : ICONS.file;
                setView(view === 'fc' ? "Main FC" : project.blocks[blockIdx].name, icon, name);
                
                currentContext = view === 'fc' ? 'fc' : blockIdx;
                if(view === 'block') renderBlockTree();
                aceEditor.setValue(view === 'fc' ? (project.fc || "") : (project.blocks[blockIdx].code || ""), -1);
                aceEditor.resize();
                
                dynamicActions.innerHTML = `<button class="btn btn-secondary" onclick="formatCode()"><svg style="width:16px;height:16px;fill:currentColor" viewBox="0 0 24 24"><path d="M21 10V21H16V20H15V19H14V17H13V15H11V14H9V12H8V10H21M4 3H18V9H17V8H16V7H15V5H14V3H4Z"/></svg> Format</button>`;
            }
            document.getElementById('crumb-title').innerText = currentContextName + (isDirty ? " ●" : "");
        }

        function renderAll() { renderHW(); renderVars(); renderDB(); renderBlockTree(); }
        
        function renderHW() {
            const tbody = document.querySelector('#hw-table tbody');
            let html = ''; if(!project.hardware) project.hardware = [];
            project.hardware.forEach((h, i) => {
                html += `<tr><td><input type="text" value="${h.name}" onchange="validateName(this); project.hardware[${i}].name=this.value"></td>
                    <td><input type="text" class="text-mono" value="${h.ip}" oninput="project.hardware[${i}].ip=this.value"></td>
                    <td><input type="number" class="text-mono" value="${h.port}" oninput="project.hardware[${i}].port=this.value"></td>
                    <td><input type="number" class="text-mono" value="${h.slave}" oninput="project.hardware[${i}].slave=this.value"></td>
                    <td><button class="btn-icon" onclick="project.hardware.splice(${i},1); renderHW()" title="Delete">${ICONS.trash}</button></td></tr>`;
            });
            tbody.innerHTML = html;
        }

    function renderVars(liveData = null) {
            const tbody = document.querySelector('#vars-table tbody');
            const devOpts = (project.hardware || []).map(h => `<option value="${h.name}">${h.name}</option>`).join('');
            let html = ''; if(!project.vars) project.vars = [];

            
            
            project.vars.forEach((v, i) => {
                const isBind = v.mode === 'binding';
                let displayVal = '<span style="color:var(--text-faint)">-</span>';
                let dotClass = 'live-dot';

                // --- 1. INSTANT MEMORY READING ---
                const memory = (liveData && liveData.variables) ? liveData.variables : liveData;
                
                if (memory && memory.hasOwnProperty(v.name)) {
                    let val = memory[v.name];
                    if (val === true || val === '1' || val === 'TRUE' || val === 1) { 
                        if(liveInterval) displayVal = `<span class="force-val" onclick="forceVar('${v.name}', 0)" style="color:var(--status-success); font-weight:600; cursor:pointer">TRUE</span>`;
                        else displayVal = '<span style="color:var(--status-success); font-weight:600">TRUE</span>';
                        dotClass += ' active'; 
                    }
                    else if (val === false || val === '0' || val === 'FALSE' || val === 0) { 
                         if(liveInterval) displayVal = `<span class="force-val" onclick="forceVar('${v.name}', 1)" style="color:var(--text-muted); cursor:pointer">FALSE</span>`;
                         else displayVal = '<span style="color:var(--text-muted)">FALSE</span>';
                    }
                    else { displayVal = `<span class="text-mono" style="color:var(--syntax-int)">${val}</span>`; }
                }

                // --- 2. AUTO-MAPPING BADGE (Now global for the row) ---
                const mbBadge = `<span class="badge badge-modbus" style="background:var(--accent-primary); color:#fff; border-radius:4px; padding:2px 6px; font-weight:bold; white-space:nowrap;">REG: ${i}</span>`;

                const details = !isBind ? 
                    `<div class="flex-row">
                        <span class="badge ${v.type==='BOOL'?'badge-bool':'badge-int'}">${v.type}</span>
                        <select onchange="project.vars[${i}].type=this.value" style="width:auto; color:var(--text-muted); margin-left:8px">
                            <option value="BOOL" ${v.type=='BOOL'?'selected':''}>BOOL</option>
                            <option value="INT" ${v.type=='INT'?'selected':''}>INT</option>
                        </select>
                    </div>` : 
                    `<div class="flex-row">
                        <select onchange="project.vars[${i}].device=this.value">${devOpts}</select>
                        <select onchange="project.vars[${i}].io=this.value" style="width:80px; color:${v.io=='INPUT'?'#dcdcaa':'#9cdcfe'}">
                            <option value="INPUT" ${v.io=='INPUT'?'selected':''}>IN</option>
                            <option value="OUTPUT" ${v.io=='OUTPUT'?'selected':''}>OUT</option>
                        </select>
                        <span style="color:var(--text-faint)">@</span>
                        <input type="number" class="text-mono" value="${v.addr}" oninput="project.vars[${i}].addr=this.value" style="width:50px">
                    </div>`;

                html += `<tr>
                    <td style="text-align:center"><div class="${dotClass}"></div></td>
                    <td><input type="text" class="text-mono" value="${v.name}" onchange="validateName(this); project.vars[${i}].name=this.value; saveProject();"></td>
                    <td>
                        <select onchange="updateVarMode(${i}, this.value)" style="color:${isBind?'var(--accent-primary)':'inherit'}">
                            <option value="simple" ${!isBind?'selected':''}>Internal Memory</option>
                            <option value="binding" ${isBind?'selected':''}>I/O Mapping</option>
                        </select>
                    </td>
                    <td><div class="flex-row">${details} ${mbBadge}</div></td> <td class="text-mono">${displayVal}</td>
                    <td><button class="btn-icon" onclick="project.vars.splice(${i},1); renderVars()">${ICONS.trash}</button></td>
                </tr>`;
            });
            tbody.innerHTML = html;
        }

        function renderDB() {
            const tbody = document.querySelector('#db-table tbody');
            let html = ''; if(!project.db) project.db = [];
            project.db.forEach((d, i) => {
                html += `<tr><td><input type="text" class="text-mono" value="${d.name}" onchange="validateName(this); project.db[${i}].name=this.value"></td><td><input type="text" class="text-mono" value="${d.val}" oninput="project.db[${i}].val=this.value"></td><td><button class="btn-icon" onclick="project.db.splice(${i},1); renderDB()">${ICONS.trash}</button></td></tr>`;
            });
            tbody.innerHTML = html;
        }

        function renderBlockTree() {
            const container = document.getElementById('block-tree-list');
            if (!project.blocks || project.blocks.length === 0) {
                container.innerHTML = `<div style="padding:20px 10px; text-align:center; color:var(--text-faint); font-size:12px; font-style:italic">No program blocks.<br>Click "+ Add Block"</div>`;
                return;
            }
            let html = ''; 
            project.blocks.forEach((b, i) => {
                html += `<div class="tree-item ${currentContext === i ? 'active' : ''}" draggable="true" data-idx="${i}" onclick="nav('block', this, ${i})"><span class="tree-icon">${ICONS.file}</span><span style="flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${b.name}</span><button class="tree-delete" onclick="removeBlock(event, ${i})" title="Delete Block">${ICONS.trash}</button></div>`;
            });
            container.innerHTML = html;
            addDnDHandlers();
            attachContextMenuEvents();
        }

        // --- TREE INTERACTIONS ---
        function promptNewBlock() {
            showPrompt("Enter New Block Name", (name) => {
                if(/^[a-zA-Z_]\w*$/.test(name)) {
                    project.blocks.push({name: name, code: "(* Logic for " + name + " *)"});
                    renderBlockTree(); log(`Created block: ${name}`, "info");
                } else { showToast("Invalid Name (Use A-Z, 0-9, _)", "error"); }
            });
        }
        
        function removeBlock(e, index) {
            e.stopPropagation();
            const blockName = project.blocks[index].name;
            if (confirm(`Delete "${blockName}"?`)) {
                project.blocks.splice(index, 1);
                if (currentContext === index) nav('fc'); 
                else if (typeof currentContext === 'number' && currentContext > index) currentContext--;
                renderBlockTree(); saveProject(); log(`Deleted block: ${blockName}`, "warn");
            }
        }

        // --- DRAG & DROP ---
        function addDnDHandlers() {
            document.querySelectorAll('.tree-item[draggable="true"]').forEach(item => {
                item.addEventListener('dragstart', (e) => { dragSrcEl = item; e.dataTransfer.effectAllowed = 'move'; item.style.opacity = '0.4'; });
                item.addEventListener('dragover', (e) => { if (e.preventDefault) e.preventDefault(); return false; });
                item.addEventListener('dragend', (e) => { item.style.opacity = '1'; });
                item.addEventListener('drop', handleDrop);
            });
        }
        function handleDrop(e) {
            e.stopPropagation();
            if (dragSrcEl !== this) {
                const srcIdx = parseInt(dragSrcEl.getAttribute('data-idx'));
                const destIdx = parseInt(this.getAttribute('data-idx'));
                const item = project.blocks.splice(srcIdx, 1)[0];
                project.blocks.splice(destIdx, 0, item);
                if(currentContext === srcIdx) currentContext = destIdx; 
                else if (currentContext > srcIdx && currentContext <= destIdx) currentContext--;
                else if (currentContext < srcIdx && currentContext >= destIdx) currentContext++;
                renderBlockTree();
            }
            return false;
        }

        // --- CONTEXT MENU ---
        function attachContextMenuEvents() {
            document.querySelectorAll('.tree-item[data-idx]').forEach(item => {
                item.addEventListener('contextmenu', (e) => {
                    e.preventDefault();
                    ctxTargetIndex = parseInt(item.getAttribute('data-idx'));
                    const menu = document.getElementById('ctx-menu');
                    menu.style.top = `${e.clientY}px`; menu.style.left = `${e.clientX}px`;
                    menu.classList.add('visible');
                });
            });
        }
        function handleCtxAction(action) {
            const menu = document.getElementById('ctx-menu'); menu.classList.remove('visible');
            if (ctxTargetIndex === null) return;
            const block = project.blocks[ctxTargetIndex];
            if (action === 'open') nav('block', null, ctxTargetIndex);
            else if (action === 'rename') {
                showPrompt(`Rename ${block.name}`, (newName) => {
                    if (/^[a-zA-Z_]\w*$/.test(newName)) { block.name = newName; renderBlockTree(); } 
                    else showToast("Invalid Name", "error");
                });
            } else if (action === 'duplicate') {
                project.blocks.push({ name: block.name + '_Copy', code: block.code }); renderBlockTree();
            } else if (action === 'delete') removeBlock({stopPropagation:()=>{}}, ctxTargetIndex);
        }

        // --- UTILS ---
        function addHw() { project.hardware.push({name:'New_Device', ip:'127.0.0.1', port:502, slave:1}); renderHW(); }
        function addVar() { project.vars.push({name:'New_Tag', mode:'simple', type:'BOOL', device:'', io:'OUTPUT', addr:0}); renderVars(); }
        function addDb() { project.db.push({name:'Init_Val', val:'0'}); renderDB(); }
        function updateVarMode(i, mode) { project.vars[i].mode = mode; if (mode === 'binding' && project.hardware.length) project.vars[i].device = project.hardware[0].name; renderVars(); }
        function validateName(input) {
            if(!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(input.value)) { input.style.borderColor = 'var(--status-error)'; showToast("Invalid Identifier", "error"); } 
            else input.style.borderColor = 'var(--border-strong)';
        }
        function setStatus(msg) { document.getElementById('status-msg').innerText = msg; }
        function log(msg, type='info') {
            const consoleDiv = document.getElementById('console-out');
            const time = new Date().toLocaleTimeString('en-US', {hour12:false});
            consoleDiv.innerHTML += `<div class="log-${type}"><span style="opacity:0.5; font-size:11px">[${time}]</span> ${msg}</div>`;
            consoleDiv.scrollTop = consoleDiv.scrollHeight;
        }
        function showToast(msg, type = 'info') {
            const container = document.getElementById('toast-container');
            const el = document.createElement('div'); el.className = `toast toast-${type}`;
            let icon = type === 'success' ? '<svg style="width:16px;height:16px;fill:var(--status-success)" viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>' : (type==='error'?'<svg style="width:16px;height:16px;fill:var(--status-error)" viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>':'<svg style="width:16px;height:16px;fill:var(--status-info)" viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2z"/></svg>');
            el.innerHTML = `${icon} <span>${msg}</span>`; container.appendChild(el);
            setTimeout(() => { el.style.animation = 'fadeOut 0.3s forwards'; setTimeout(() => el.remove(), 300); }, 3000);
        }
        function toggleTerminal() {
            const app = document.getElementById('app-container');
            app.classList.toggle('terminal-closed');
            setTimeout(() => aceEditor.resize(), 200);
        }

        // --- LIVE MODE ---
        function toggleLiveMode() {
            if(liveInterval) { stopLiveMode(); return; }
            document.getElementById('btn-live').classList.replace('btn-secondary','btn'); 
            document.querySelector('.live-dot').classList.add('active'); log("Live Monitor Started", "info");
            liveInterval = setInterval(async () => {
                try {
                    const res = await fetch('api.php?action=status'); const liveData = await res.json();
                    document.getElementById('connection-indicator').innerHTML = `<span style="width:6px;height:6px;border-radius:50%;background:#10b981; margin-right:6px"></span> System: Online`;
                    if(document.getElementById('view-vars').classList.contains('active')) renderVars(liveData); 
                } catch(e) { document.getElementById('connection-indicator').innerHTML = `<span style="width:6px;height:6px;border-radius:50%;background:#ef4444; margin-right:6px"></span> System: Offline`; }
            }, 1000);
        }
        function stopLiveMode() {
            if(!liveInterval) return; clearInterval(liveInterval); liveInterval = null;
            const btn = document.getElementById('btn-live'); btn.classList.replace('btn','btn-secondary'); 
            document.querySelector('.live-dot').classList.remove('active'); log("Live Monitor Stopped", "info"); renderVars(); 
        }

        // --- MODALS & SETTINGS ---
        function openSettings() {
            document.getElementById('modal-title').innerText = "Editor Settings";
            document.getElementById('modal-body').innerHTML = `
                <label>Theme</label>
                <button class="btn btn-secondary" style="width:100%; margin-bottom:15px; justify-content:center" onclick="toggleTheme()">Toggle Light/Dark Mode</button>
                <label>Font Size (px)</label>
                <input type="number" id="setting-font" value="${settings.fontSize}">
                <button class="btn" style="width:100%" onclick="applySettings()">Apply Settings</button>
            `;
            document.getElementById('modal-actions').style.display = 'none'; // Hide default buttons
            document.getElementById('modal-overlay').classList.add('open');
        }

        function toggleTheme() {
            const html = document.documentElement;
            const current = html.getAttribute('data-theme');
            const next = current === 'light' ? 'dark' : 'light';
            html.setAttribute('data-theme', next);
            if(next === 'light') aceEditor.setTheme("ace/theme/chrome");
            else aceEditor.setTheme("ace/theme/dracula");
            showToast(`Switched to ${next} mode`, "info");
        }

        function applySettings() {
            const size = document.getElementById('setting-font').value;
            settings.fontSize = parseInt(size);
            document.documentElement.style.setProperty('--editor-font-size', size + 'px');
            aceEditor.setFontSize(size + 'px');
            closeModal();
            showToast("Settings Saved", "success");
        }

        function showPrompt(title, callback) {
            document.getElementById('modal-title').innerText = title;
            document.getElementById('modal-body').innerHTML = `<input type="text" id="modal-input" autofocus>`;
            document.getElementById('modal-actions').style.display = 'flex';
            document.getElementById('modal-overlay').classList.add('open');
            document.getElementById('modal-input').focus();
            modalCallback = callback;
        }
        function closeModal() { document.getElementById('modal-overlay').classList.remove('open'); modalCallback = null; }
        document.getElementById('modal-confirm').onclick = () => { if(modalCallback) modalCallback(document.getElementById('modal-input').value); closeModal(); };
        document.addEventListener('keydown', (e) => { 
            if(e.key === 's' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveProject(); }
            if(e.key === 'p' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); openCommandPalette(); }
            if(e.key === 'Escape') closeModal();
        });
        window.onbeforeunload = () => { if (isDirty) return "You have unsaved changes."; };

        function openCommandPalette() {
            const commands = [
                { name: "> Hardware Configuration", action: () => nav('hw') },
                { name: "> PLC Tags", action: () => nav('vars') },
                { name: "> Data Blocks", action: () => nav('db') },
                { name: "> Main Program", action: () => nav('fc') },
                { name: "> Toggle Terminal", action: () => toggleTerminal() },
                { name: "> Save Project", action: () => saveProject() },
                { name: "> Deploy", action: () => deploy() },
                { name: "> Export JSON", action: () => downloadProject() },
                { name: "> Toggle Theme", action: () => toggleTheme() }
            ];
            project.blocks.forEach((b, i) => commands.push({ name: `Block: ${b.name}`, action: () => nav('block', null, i) }));
            showPrompt("Command Palette", (val) => {
                const cmd = commands.find(c => c.name.toLowerCase().includes(val.toLowerCase()));
                if(cmd) cmd.action();
            });
            document.getElementById('modal-input').placeholder = "Type to search files or commands...";
        }

    </script>
</body>
</html>