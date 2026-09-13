//! Pinned, public model assets only. Meeting text never leaves this process.
use super::{index::Result, private_directory};
use fastembed::{
    InitOptionsUserDefined, Pooling, TextEmbedding, TokenizerFiles, UserDefinedEmbeddingModel,
};
use futures_util::StreamExt;
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::io::AsyncWriteExt;

pub const REVISION: &str = "614241f622f53c4eeff9890bdc4f31cfecc418b3";
pub const MODEL_ID: &str =
    "multilingual-e5-small:614241f622f53c4eeff9890bdc4f31cfecc418b3:384:passage:v1";
const FILES: &[(&str, u64, Option<&str>)] = &[
    (
        "onnx/model.onnx",
        470268510,
        Some("ca456c06b3a9505ddfd9131408916dd79290368331e7d76bb621f1cba6bc8665"),
    ),
    (
        "tokenizer.json",
        17082730,
        Some("0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39"),
    ),
    ("config.json", 655, None),
    ("special_tokens_map.json", 167, None),
    ("tokenizer_config.json", 443, None),
];

/// Preserve every byte even for unusual text that exceeds E5's tokenizer limit.
/// Ordinary passages use one embedding; oversized inputs pool bounded windows.
pub fn embed(model: &mut TextEmbedding, texts: Vec<String>) -> Result<Vec<Vec<f32>>> {
    let mut tokenizer = model.tokenizer.clone();
    tokenizer
        .with_truncation(None)
        .map_err(|_| "Cannot configure tokenizer")?;
    let mut windows = Vec::new();
    let mut ranges = Vec::new();
    for text in texts {
        let first = windows.len();
        let tokens = tokenizer
            .encode(text.as_str(), true)
            .map_err(|_| "Cannot tokenize passage")?
            .len();
        if tokens <= 480 {
            windows.push(text);
        } else {
            let (prefix, content) = if let Some(content) = text.strip_prefix("query: ") {
                ("query: ", content)
            } else {
                ("passage: ", text.strip_prefix("passage: ").unwrap_or(&text))
            };
            let mut start = 0;
            while start < content.len() {
                let mut end = (start + 400).min(content.len());
                while !content.is_char_boundary(end) {
                    end -= 1;
                }
                windows.push(format!("{prefix}{}", &content[start..end]));
                start = end;
            }
        }
        ranges.push(first..windows.len());
    }
    let vectors = model
        .embed(windows, Some(8))
        .map_err(|_| "Local embedding failed")?;
    let mut result = Vec::new();
    for range in ranges {
        let mut pooled = vec![0.0f32; 384];
        for vector in &vectors[range] {
            if vector.len() != 384 {
                return Err("Unexpected embedding dimension".into());
            }
            for (sum, value) in pooled.iter_mut().zip(vector) {
                *sum += value;
            }
        }
        let norm = pooled.iter().map(|v| v * v).sum::<f32>().sqrt();
        if !norm.is_finite() || norm == 0.0 {
            return Err("Invalid embedding vector".into());
        }
        for v in &mut pooled {
            *v /= norm;
        }
        result.push(pooled);
    }
    Ok(result)
}

async fn valid(path: PathBuf, size: u64, checksum: Option<&'static str>) -> bool {
    tokio::task::spawn_blocking(move || {
        use std::io::Read;
        let Ok(mut f) = std::fs::File::open(path) else {
            return false;
        };
        if f.metadata().map(|m| m.len()).ok() != Some(size) {
            return false;
        }
        if let Some(expected) = checksum {
            let mut hash = Sha256::new();
            let mut buffer = [0u8; 65536];
            loop {
                match f.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(n) => hash.update(&buffer[..n]),
                    Err(_) => return false,
                }
            }
            return format!("{:x}", hash.finalize()) == expected;
        }
        true
    })
    .await
    .unwrap_or(false)
}

pub async fn load(cache: &Path) -> Result<TextEmbedding> {
    let root = cache.join(REVISION);
    private_directory(&root)?;
    private_directory(&root.join("onnx"))?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(1200))
        .connect_timeout(Duration::from_secs(15))
        .build()
        .map_err(|_| "Model download unavailable")?;
    for &(file, size, checksum) in FILES {
        let path = root.join(file);
        if valid(path.clone(), size, checksum).await {
            continue;
        }
        let url = format!(
            "https://huggingface.co/intfloat/multilingual-e5-small/resolve/{REVISION}/{file}"
        );
        let response = client
            .get(url)
            .send()
            .await
            .and_then(|r| r.error_for_status())
            .map_err(|_| "Model download failed")?;
        let temp = path.with_extension("download");
        let mut output = tokio::fs::File::create(&temp)
            .await
            .map_err(|_| "Cannot write model cache")?;
        let mut stream = response.bytes_stream();
        let mut bytes = 0;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| "Model download interrupted")?;
            bytes += chunk.len() as u64;
            if bytes > size {
                return Err("Model artifact exceeds expected size".into());
            }
            output
                .write_all(&chunk)
                .await
                .map_err(|_| "Cannot write model cache")?;
        }
        output
            .flush()
            .await
            .map_err(|_| "Cannot finish model download")?;
        drop(output);
        if !valid(temp.clone(), size, checksum).await {
            return Err("Model artifact checksum mismatch".into());
        }
        tokio::fs::rename(temp, path)
            .await
            .map_err(|_| "Cannot publish model cache")?;
    }
    tokio::task::spawn_blocking(move || {
        let read = |file: &str| {
            std::fs::read(root.join(file)).map_err(|_| "Cannot read model cache".to_string())
        };
        let tokenizer = TokenizerFiles {
            tokenizer_file: read("tokenizer.json")?,
            config_file: read("config.json")?,
            special_tokens_map_file: read("special_tokens_map.json")?,
            tokenizer_config_file: read("tokenizer_config.json")?,
        };
        let model = UserDefinedEmbeddingModel::new(read("onnx/model.onnx")?, tokenizer)
            .with_pooling(Pooling::Mean);
        TextEmbedding::try_new_from_user_defined(
            model,
            InitOptionsUserDefined::new()
                .with_max_length(512)
                .with_intra_threads(1),
        )
        .map_err(|_| "Cannot initialize local embeddings".to_string())
    })
    .await
    .map_err(|_| "Model worker stopped")?
}
