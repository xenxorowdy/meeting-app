const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const postcss = require('postcss');

const stylesheet = postcss.parse(fs.readFileSync(path.join(__dirname, '../apps/ui/src/design.css'), 'utf8'));

function tokensFor(selector) {
    const tokens = {};
    stylesheet.walkRules(selector, rule => {
        rule.walkDecls(/^--ks-/, declaration => {
            tokens[declaration.prop] = declaration.value;
        });
    });
    assert(Object.keys(tokens).length, `Palette exists: ${selector}`);
    return tokens;
}

function luminance(hex) {
    if (/^#[a-f\d]{3}$/i.test(hex)) hex = '#' + [...hex.slice(1)].map(channel => channel.repeat(2)).join('');
    assert.match(hex, /^#[a-f\d]{6}$/i);
    const channels = hex
        .slice(1)
        .match(/../g)
        .map(channel => {
            const value = parseInt(channel, 16) / 255;
            return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
        });
    return channels.reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
}

function contrast(front, back) {
    const values = [luminance(front), luminance(back)];
    return (Math.max(...values) + 0.05) / (Math.min(...values) + 0.05);
}

for (const theme of ['dark', 'light']) {
    const palette = {
        ...tokensFor('.ks-app'),
        ...(theme === 'light' ? tokensFor(".ks-app[data-theme='light']") : {}),
        ...tokensFor('.ks-workspace'),
        ...(theme === 'light' ? tokensFor(".ks-app[data-theme='light'] .ks-workspace") : {}),
    };

    test(`${theme} workspace text colors reach 4.5:1 on solid surfaces`, () => {
        for (const text of ['text', 'secondary', 'muted', 'accent-text', 'danger', 'warn', 'ok']) {
            for (const surface of ['bg', 'surface', 'raised', 'hover', 'workspace-panel', 'workspace-sidebar', 'chat-bg']) {
                const ratio = contrast(palette[`--ks-${text}`], palette[`--ks-${surface}`]);
                assert(ratio >= 4.5, `${text} on ${surface}: ${ratio.toFixed(2)}:1`);
            }
        }
    });

    test(`${theme} input edge reaches 3:1 on the input surface`, () => {
        assert(contrast(palette['--ks-control-edge'], palette['--ks-surface']) >= 3);
    });
}
