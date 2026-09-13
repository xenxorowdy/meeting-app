const assert = require('node:assert/strict');
const { test } = require('node:test');
const load = () => import('../apps/ui/src/lib/levels.js');

function fakeFrames() {
    const queue = [];
    let id = 0;
    return {
        schedule(callback) {
            id += 1;
            queue.push({ id, callback });
            return id;
        },
        cancel(handle) {
            const index = queue.findIndex(entry => entry.id === handle);
            if (index !== -1) queue.splice(index, 1);
        },
        paint() {
            const due = queue.splice(0, queue.length);
            for (const entry of due) entry.callback();
            return due.length;
        },
        get scheduled() {
            return queue.length;
        },
    };
}

test('a burst of readings costs one notification per frame', async () => {
    const { createLevelChannel } = await load();
    const frames = fakeFrames();
    const channel = createLevelChannel(frames);
    const seen = [];
    channel.subscribe(level => seen.push(level.mic));

    assert.deepEqual(seen, [0], 'a new subscriber is given the current reading immediately');

    // One second of a 16 kHz stream in 128-frame quanta is 125 packets.
    for (let i = 1; i <= 125; i += 1) channel.publish({ mic: i, system: 0 });
    assert.equal(frames.scheduled, 1, '125 readings schedule a single frame, not 125');
    assert.deepEqual(seen, [0], 'nothing is delivered until the frame runs');

    frames.paint();
    assert.deepEqual(seen, [0, 125], 'the frame delivers only the newest reading');
});

test('the latest reading is readable before its frame runs', async () => {
    const { createLevelChannel } = await load();
    const frames = fakeFrames();
    const channel = createLevelChannel(frames);

    channel.publish({ mic: 42, system: 7 });
    assert.deepEqual(channel.current, { mic: 42, system: 7 });

    const late = [];
    channel.subscribe(level => late.push(level));
    assert.deepEqual(late, [{ mic: 42, system: 7 }], 'a subscriber joining mid-burst is not left at zero');
});

test('unsubscribing stops delivery and leaves no listener behind', async () => {
    const { createLevelChannel } = await load();
    const frames = fakeFrames();
    const channel = createLevelChannel(frames);
    const seen = [];
    const stop = channel.subscribe(level => seen.push(level.mic));

    channel.publish({ mic: 10, system: 0 });
    frames.paint();
    stop();
    channel.publish({ mic: 20, system: 0 });
    frames.paint();

    assert.deepEqual(seen, [0, 10]);
    assert.equal(channel.listenerCount, 0);
});

test('reset drops a pending frame so a stopped meeting cannot repaint a stale level', async () => {
    const { createLevelChannel } = await load();
    const frames = fakeFrames();
    const channel = createLevelChannel(frames);
    const seen = [];
    channel.subscribe(level => seen.push(level.mic));

    channel.publish({ mic: 88, system: 88 });
    channel.reset();

    assert.deepEqual(channel.current, { mic: 0, system: 0 });
    assert.equal(frames.scheduled, 0, 'the queued frame is cancelled, not left to fire after the meeting ended');
    assert.deepEqual(seen, [0, 0], 'subscribers are told the meter is silent');
});
