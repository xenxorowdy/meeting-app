import { useCallback, useEffect, useRef, useState } from 'react';
import { apiRequest, createBackendSocket } from '@/lib/backend';

export function usePodcastStudio() {
    const bridge = globalThis.alphaPodcast || null;
    const [projects, setProjects] = useState([]);
    const [activeProject, setActiveProject] = useState(null);
    const [settings, setSettings] = useState({ youtubeConnected: false });
    const [isBusy, setIsBusy] = useState(false);
    const [error, setError] = useState(null);
    const [jobProgress, setJobProgress] = useState(null);
    const saveTimer = useRef(null);

    const reload = useCallback(async () => {
        if (!bridge) return [];
        try {
            const [items, storedSettings] = await Promise.all([bridge.list(), bridge.settings()]);
            setProjects(items);
            setSettings(storedSettings);
            return items;
        } catch (cause) {
            setError(cause.message);
            return [];
        }
    }, [bridge]);

    useEffect(() => {
        reload();
        return () => clearTimeout(saveTimer.current);
    }, [reload]);

    useEffect(() => {
        if (!bridge) return undefined;
        const socket = createBackendSocket({
            onEvent: message => {
                if (message.type !== 'podcast_job_progress') return;
                setJobProgress(message.data || null);
                if (message.data?.status === 'failed') setError(message.data.error || 'Podcast job failed.');
            },
        });
        return () => socket.close();
    }, [bridge]);

    const perform = useCallback(async task => {
        setIsBusy(true);
        setError(null);
        try {
            return await task();
        } catch (cause) {
            setError(cause.message || String(cause));
            return null;
        } finally {
            setIsBusy(false);
        }
    }, []);

    const openProject = useCallback(async projectOrId => {
        if (!bridge) return null;
        const project = typeof projectOrId === 'string' ? await bridge.get(projectOrId) : projectOrId;
        setActiveProject(project);
        return project;
    }, [bridge]);

    const createProject = useCallback(options => perform(async () => {
        const project = await bridge.create(options);
        setActiveProject(project);
        await reload();
        return project;
    }), [bridge, perform, reload]);

    const saveProject = useCallback(async project => {
        if (!bridge || !project) return null;
        clearTimeout(saveTimer.current);
        const saved = await bridge.save(project);
        setActiveProject(saved);
        setProjects(current => current.map(item => item.id === saved.id ? saved : item));
        return saved;
    }, [bridge]);

    const queueSave = useCallback(project => {
        setActiveProject(project);
        clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(() => saveProject(project).catch(cause => setError(cause.message)), 350);
    }, [saveProject]);

    const refreshActive = useCallback(async () => {
        if (!bridge || !activeProject) return null;
        clearTimeout(saveTimer.current);
        const project = await bridge.get(activeProject.id);
        setActiveProject(project);
        await reload();
        return project;
    }, [activeProject, bridge, reload]);

    const generateScript = useCallback((project, sourceMeeting = null) => perform(async () => {
        await saveProject(project);
        await apiRequest(`/api/podcasts/${project.id}/script`, {
            method: 'POST',
            body: {
                title: project.title,
                language: project.language,
                hosts: project.script.hosts,
                ...(sourceMeeting?.id ? { meetingId: sourceMeeting.id } : { transcript: project.transcript || [] }),
            },
        });
        return refreshActive();
    }), [perform, refreshActive, saveProject]);

    const generateVoice = useCallback(project => perform(async () => {
        await saveProject({ ...project, generationDisclosureAcceptedAt: project.generationDisclosureAcceptedAt || Date.now() });
        await apiRequest(`/api/podcasts/${project.id}/voice`, { method: 'POST', body: {} });
        return refreshActive();
    }), [perform, refreshActive, saveProject]);

    const transcribe = useCallback((projectId, assetPath) => perform(async () => {
        await apiRequest(`/api/podcasts/${projectId}/transcribe`, { method: 'POST', body: { assetPath } });
        return refreshActive();
    }), [perform, refreshActive]);

    const callBridge = useCallback((method, ...args) => perform(async () => {
        clearTimeout(saveTimer.current);
        const projectMethods = new Set(['importFile', 'addAsset', 'importRss', 'waveform', 'cleanSpeech', 'render', 'importYouTube', 'publishYouTube']);
        if (activeProject && projectMethods.has(method) && args[0] === activeProject.id) {
            await saveProject(activeProject);
        }
        const result = await bridge[method](...args);
        if (result?.project) setActiveProject(result.project);
        await reload();
        return result;
    }), [activeProject, bridge, perform, reload, saveProject]);

    return {
        isDesktop: Boolean(bridge), projects, activeProject, settings, isBusy, error, jobProgress,
        setError, reload, openProject, setActiveProject, createProject, saveProject, queueSave, refreshActive,
        generateScript, generateVoice, transcribe, callBridge,
    };
}
